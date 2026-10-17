import { afterEach, describe, expect, it } from "bun:test";
import { DiscordNotifier, formatBatch, maskWebhookUrl, NOTIFY_KINDS, parseNotifyKinds, parseWebhookUrl, redact, type NotifierOptions, type NotifyKind } from "../src/notify";
import { emptyAgentState, type AgentEvent, type AgentState, type LiveMessage } from "../src/types";

const URL_ = "https://discord.example/api/webhooks/123/s3cr3t-token";
const T0 = Date.parse("2026-10-09T18:00:00Z");

const ev = (seq: number, type: AgentEvent["type"], data: Record<string, unknown>, at = T0 + seq * 1000): AgentEvent => ({ seq, ts: new Date(at).toISOString(), type, data });
const live = (e: AgentEvent): LiveMessage => ({ type: "event", event: e });

function state(edit: (s: AgentState) => void = () => undefined): LiveMessage {
  const s = emptyAgentState();
  s.server.status = "running";
  s.server.joinCode = "482915";
  s.server.version = "l-1.0.19";
  edit(s);
  return { type: "state", state: s, online: true };
}

type Call = { url: string; body: { content: string; allowed_mentions: unknown }; signal: AbortSignal | null };

/** A fake Discord: answers from `replies` in order, then 204. */
function fakeDiscord(replies: Array<Response | Error> = []) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string), signal: init.signal ?? null });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r ?? new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, contents: () => calls.map((c) => c.body.content) };
}

const running: DiscordNotifier[] = [];
afterEach(() => {
  for (const n of running.splice(0)) n.stop();
});

function notifier(fetchImpl: typeof fetch, opts: Partial<NotifierOptions> = {}) {
  let now = T0;
  const logs: string[] = [];
  const waits: number[] = [];
  const n = new DiscordNotifier({
    url: URL_,
    kinds: NOTIFY_KINDS,
    locale: "en",
    fetchImpl,
    clock: () => now,
    log: (l) => logs.push(l),
    sleep: async (ms) => void waits.push(ms),
    coalesceMs: 20,
    serverHoldMs: 30,
    ...opts,
  });
  running.push(n);
  n.handle(state());
  return { n, logs, waits, at: (ms: number) => (now = T0 + ms) };
}

const settle = async (n: DiscordNotifier, ms = 60) => {
  await Bun.sleep(ms);
  await n.idle();
};

describe("formatBatch", () => {
  it("merges joins, leaves and deaths into one line each", () => {
    const lines = formatBatch(
      [
        { kind: "join", name: "Ragnar" },
        { kind: "join", name: "Freya" },
        { kind: "join", name: "Bjorn" },
        { kind: "leave", name: "Ragnar", ms: 64 * 60_000 },
        { kind: "death", name: "Freya" },
        { kind: "death", name: "Freya" },
      ],
      "en",
    );
    expect(lines).toEqual(["Ragnar, Freya, and Bjorn arrive at the fire", "Ragnar (1 h 4 min) walks into the dark", "Freya (2×) falls in battle"]);
  });

  it("speaks Polish", () => {
    expect(
      formatBatch(
        [
          { kind: "join", name: "Ragnar" },
          { kind: "join", name: "Freya" },
          { kind: "leave", name: "Bjorn", ms: 20_000 },
          { kind: "raid", raid: "army_goblin" },
          { kind: "version", version: "l-1.0.20" },
          { kind: "join_code", code: "730114" },
          { kind: "server", status: "running" },
          { kind: "failure", what: "settings", error: "timeout" },
        ],
        "pl",
      ),
    ).toEqual([
      "Ragnar i Freya przybywają do ogniska",
      "Bjorn (niecała minuta) odchodzi w mrok",
      "Najazd: Horda atakuje",
      "Gra zaktualizowana do 1.0.20",
      "Nowy kod dołączenia: **730114**",
      "Ogień znów płonie, serwer działa",
      "Nie udało się zastosować nowych ustawień (timeout)",
    ]);
  });

  it("names unknown raids as they are and escapes markdown in names", () => {
    expect(formatBatch([{ kind: "raid", raid: "army_new" }], "en")).toEqual(["Raid: army\\_new"]);
    expect(formatBatch([{ kind: "join", name: "*Ragnar*_" }], "en")).toEqual(["\\*Ragnar\\*\\_ arrives at the fire"]);
    expect(formatBatch([{ kind: "failure", what: "admin", actor: "Freya", command: "spawn", error: "no such item" }], "en")).toEqual(["Freya: spawn failed (no such item)"]);
    expect(formatBatch([{ kind: "failure", what: "action", action: "restart", error: "exit 1" }], "en")).toEqual(["Server restart failed (exit 1)"]);
  });
});

describe("parseNotifyKinds", () => {
  it("defaults to everything and rejects unknown kinds", () => {
    expect(parseNotifyKinds("")).toEqual([...NOTIFY_KINDS]);
    expect(parseNotifyKinds(" join_code ,failure,join_code")).toEqual(["join_code", "failure"] as NotifyKind[]);
    expect(() => parseNotifyKinds("join,world_saved")).toThrow("world_saved");
  });
});

describe("DiscordNotifier", () => {
  it("coalesces five joins within the window into one message, without mentions", async () => {
    const d = fakeDiscord();
    const { n } = notifier(d.fetchImpl);
    for (const [i, name] of ["Ragnar", "Freya", "Bjorn", "Astrid", "Leif"].entries()) n.handle(live(ev(i + 1, "player_join", { name })));
    await settle(n);
    expect(d.contents()).toEqual(["Ragnar, Freya, Bjorn, Astrid, and Leif arrive at the fire"]);
    expect(d.calls[0]!.url).toBe(URL_);
    expect(d.calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(d.calls[0]!.signal).not.toBeNull();
  });

  it("gives a leave the visit length, also for players online at boot", async () => {
    const d = fakeDiscord();
    let now = T0;
    const n = new DiscordNotifier({ url: URL_, kinds: NOTIFY_KINDS, locale: "en", fetchImpl: d.fetchImpl, clock: () => now, coalesceMs: 10 });
    running.push(n);
    n.handle(state((s) => (s.players = [{ name: "Freya", since: new Date(T0 - 30 * 60_000).toISOString() }])));
    n.handle(live(ev(1, "player_join", { name: "Ragnar" }, T0 + 1000)));
    now = T0 + 2 * 3600_000;
    n.handle(live(ev(2, "player_leave", { name: "Ragnar" }, T0 + 2 * 3600_000 + 1000)));
    n.handle(live(ev(3, "player_leave", { name: "Freya" }, T0 + 2 * 3600_000 + 2000)));
    await settle(n);
    expect(d.contents().join("\n")).toContain("Ragnar (2 h) and Freya (2 h 30 min) walk into the dark");
  });

  it("sends nothing from before boot and never the same event twice", async () => {
    const d = fakeDiscord();
    const { n } = notifier(d.fetchImpl);
    // Replayed on connect: the agent's buffer from before skald-web started.
    n.handle(live(ev(1, "death", { name: "Bjorn" }, T0 - 60_000)));
    const death = ev(2, "death", { name: "Ragnar" });
    n.handle(live(death));
    // A reconnect replays it again.
    n.handle(live({ ...death }));
    await settle(n);
    expect(d.contents()).toEqual(["Ragnar falls in battle"]);
  });

  it("never sends routine saves or backups", async () => {
    const d = fakeDiscord();
    const { n } = notifier(d.fetchImpl);
    n.handle(live(ev(1, "world_saved", { ms: 120 })));
    n.handle(live(ev(2, "world_backup", { ms: 30 })));
    n.handle(live(ev(3, "log", { line: "x" })));
    n.handle(live(ev(4, "settings_apply", { state: "applied", mode: "now" })));
    n.handle(live(ev(5, "admin", { actor: "Freya", command: "save", result: "ok" })));
    await settle(n);
    expect(d.calls).toHaveLength(0);
  });

  it("announces a new join code and a game update once, not the baseline", async () => {
    const d = fakeDiscord();
    const { n } = notifier(d.fetchImpl);
    n.handle(live(ev(1, "join_code", { code: "482915" }))); // the code the state already had
    n.handle(live(ev(2, "version", { version: "l-1.0.19", networkVersion: 40 })));
    await settle(n);
    expect(d.calls).toHaveLength(0);
    n.handle(live(ev(3, "version", { version: "l-1.0.20", networkVersion: 41 })));
    n.handle(live(ev(4, "join_code", { code: "730114" })));
    n.handle(live(ev(5, "join_code", { code: "730114" })));
    await settle(n);
    expect(d.contents().join("\n")).toBe("Game updated to 1.0.20\nNew join code: **730114**");
  });

  it("debounces server state flapping and announces the state that holds", async () => {
    const d = fakeDiscord();
    const { n } = notifier(d.fetchImpl);
    n.handle(live(ev(1, "server_state", { status: "stopping" })));
    n.handle(live(ev(2, "server_state", { status: "stopped" })));
    n.handle(live(ev(3, "server_state", { status: "running" })));
    await settle(n, 80);
    expect(d.calls).toHaveLength(0);
    n.handle(live(ev(4, "server_state", { status: "stopped" })));
    await settle(n, 80);
    n.handle(live(ev(5, "server_state", { status: "starting" })));
    n.handle(live(ev(6, "server_state", { status: "running" })));
    await settle(n, 80);
    expect(d.contents()).toEqual(["Server stopped", "The fire burns again, the server is up"]);
  });

  it("reports failed admin commands, settings applies and actions", async () => {
    const d = fakeDiscord();
    const { n } = notifier(d.fetchImpl);
    n.handle(live(ev(1, "admin", { actor: "Freya", command: "kick", result: "error", error: "player not found" })));
    n.handle(live(ev(2, "settings_apply", { state: "failed", mode: "now", message: "server did not come back" })));
    n.handle(live(ev(3, "action", { name: "update", ok: false, message: "updater busy" })));
    await settle(n);
    expect(d.contents().join("\n")).toBe("Freya: kick failed (player not found)\nApplying the new settings failed (server did not come back)\nUpdate check failed (updater busy)");
  });

  it("sends only the kinds DISCORD_NOTIFY lists", async () => {
    const d = fakeDiscord();
    const { n } = notifier(d.fetchImpl, { kinds: ["join_code"] });
    n.handle(live(ev(1, "player_join", { name: "Ragnar" })));
    n.handle(live(ev(2, "raid", { name: "wolves" })));
    n.handle(live(ev(3, "join_code", { code: "730114" })));
    await settle(n);
    expect(d.contents()).toEqual(["New join code: **730114**"]);
  });

  it("waits out a 429 for retry_after seconds and sends again", async () => {
    const limited = () => new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: 1.5, global: false }), { status: 429, headers: { "Retry-After": "2" } });
    const d = fakeDiscord([limited(), new Response("{}", { status: 429, headers: { "Retry-After": "3" } })]);
    const { n, waits, logs } = notifier(d.fetchImpl);
    n.handle(live(ev(1, "raid", { name: "wolves" })));
    await settle(n);
    expect(waits).toEqual([1500, 3000]);
    expect(d.contents()).toEqual(["Raid: You are being hunted...", "Raid: You are being hunted...", "Raid: You are being hunted..."]);
    expect(logs).toEqual([]);
  });

  it("gives up after the retries and logs it", async () => {
    const limited = () => new Response(JSON.stringify({ retry_after: 500 }), { status: 429 });
    const d = fakeDiscord([limited(), limited(), limited()]);
    const { n, waits, logs } = notifier(d.fetchImpl, { maxRetries: 2 });
    n.handle(live(ev(1, "raid", { name: "wolves" })));
    await settle(n);
    // Capped: a huge retry_after never parks the queue for long.
    expect(waits).toEqual([60_000, 60_000]);
    expect(logs).toEqual(["discord: message dropped: HTTP 429"]);
  });

  it("times out a hanging Discord without blocking the next event", async () => {
    const fetchImpl = ((_: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error(`request to ${URL_} timed out`))))) as unknown as typeof fetch;
    const { n, logs } = notifier(fetchImpl, { timeoutMs: 20 });
    n.handle(live(ev(1, "raid", { name: "wolves" })));
    await settle(n, 80);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("s3cr3t");
    expect(logs[0]).toContain("[webhook]");
  });

  it("never leaks the webhook URL from errors, logs or the test result", async () => {
    const d = fakeDiscord([new Error(`connect ECONNREFUSED ${URL_}`)]);
    const { n, logs } = notifier(d.fetchImpl);
    const res = await n.test();
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("s3cr3t");
    expect(JSON.stringify(res)).toContain("[webhook]");
    expect(logs).toEqual([]);
    expect(d.contents()).toEqual(["Test notification from Skald. Discord notifications work."]);
  });

  it("does not throw from the listener, whatever arrives", () => {
    const { n } = notifier(fakeDiscord().fetchImpl);
    expect(() => n.handle(live({ seq: 1, ts: "not a date", type: "player_join", data: {} }))).not.toThrow();
    expect(() => n.handle({ type: "positions", t: 0, players: [] })).not.toThrow();
  });
});

describe("redact", () => {
  it("removes the configured URL and anything shaped like a webhook", () => {
    expect(redact(`failed: ${URL_}`, URL_)).toBe("failed: [webhook]");
    expect(redact("at https://discord.com/api/webhooks/9/other: refused", "")).toBe("at [webhook] refused");
  });
});

describe("webhook URL from the admin sheet", () => {
  it("accepts only Discord's webhook shape and canonicalises it", () => {
    expect(parseWebhookUrl(" https://discord.com/api/webhooks/42/Ab_c-9 ")).toBe("https://discord.com/api/webhooks/42/Ab_c-9");
    expect(parseWebhookUrl("https://DiscordApp.com/api/webhooks/42/x")).toBe("https://discordapp.com/api/webhooks/42/x");
    expect(parseWebhookUrl("https://canary.discord.com/api/webhooks/42/x")).toBe("https://canary.discord.com/api/webhooks/42/x");
    expect(parseWebhookUrl("https://ptb.discord.com/api/webhooks/42/x?thread_id=77")).toBe("https://ptb.discord.com/api/webhooks/42/x?thread_id=77");
    for (const bad of [
      "https://evil.discord.com/api/webhooks/42/x",
      "https://discord.com/api/webhooks/42/x?thread_id=1&wait=true",
      "https://discord.com/api/webhooks/42/x?thread_id=abc",
      "https://discord.com/api/webhooks/42/x y",
      "ftp://discord.com/api/webhooks/42/x",
    ]) {
      expect([bad, parseWebhookUrl(bad)]).toEqual([bad, null]);
    }
  });

  it("masks to the id's tail and the token's head", () => {
    expect(maskWebhookUrl("https://discord.com/api/webhooks/123456789/abcdefghij")).toBe("discord.com/api/webhooks/…6789/abcd…");
    expect(maskWebhookUrl("https://hooks.example/private/path?token=s3cr3t")).toBe("hooks.example/…");
    expect(maskWebhookUrl("not a url")).toBe("…");
  });
});

describe("DiscordNotifier.configure", () => {
  it("sends nothing while off, keeps its baseline and starts sending once configured", async () => {
    const d = fakeDiscord();
    const { n } = notifier(d.fetchImpl, { url: "" });
    n.handle(live(ev(1, "raid", { name: "wolves" })));
    n.handle(live(ev(2, "join_code", { code: "482915" })));
    await settle(n);
    expect(d.calls).toHaveLength(0);
    expect(await n.test()).toEqual({ ok: false, error: "not_configured" });
    n.configure({ url: URL_, kinds: ["raid", "join_code"] });
    // The baseline join code from the first state is still known: not news.
    n.handle(live(ev(3, "join_code", { code: "482915" })));
    n.handle(live(ev(4, "raid", { name: "wolves" })));
    n.handle(live(ev(5, "death", { name: "Ragnar" })));
    await settle(n);
    expect(d.contents()).toEqual(["Raid: You are being hunted..."]);
    expect(d.calls[0]!.url).toBe(URL_);
  });

  it("stops retrying a message once its webhook is removed, and drops what was queued for the old one", async () => {
    const d = fakeDiscord([new Response("{}", { status: 429, headers: { "Retry-After": "1" } })]);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { n, logs } = notifier(d.fetchImpl, { sleep: () => gate });
    n.handle(live(ev(1, "raid", { name: "wolves" })));
    await Bun.sleep(30);
    n.handle(live(ev(2, "raid", { name: "bats" })));
    await Bun.sleep(30);
    expect(d.calls).toHaveLength(1);
    n.configure({ url: "https://discord.example/api/webhooks/9/new", kinds: NOTIFY_KINDS });
    release();
    await settle(n);
    // Neither the retry nor the queued raid went anywhere.
    expect(d.calls.map((c) => c.url)).toEqual([URL_]);
    expect(logs).toEqual(["discord: message dropped: webhook changed"]);
  });

  it("drops what waits when turned off, and tests another webhook on request", async () => {
    const d = fakeDiscord();
    const { n } = notifier(d.fetchImpl, { coalesceMs: 40 });
    n.handle(live(ev(1, "player_join", { name: "Freya" })));
    n.configure(null);
    await settle(n, 80);
    expect(d.calls).toHaveLength(0);
    const other = "https://discord.example/api/webhooks/9/other";
    expect(await n.test(other)).toEqual({ ok: true });
    expect(d.calls.map((c) => c.url)).toEqual([other]);
  });
});
