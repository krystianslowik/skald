import { afterEach, describe, expect, it } from "bun:test";
import { applyEvent } from "../src/apply";
import { MockSafeRestart, MOCK_MINUTE_MS, type MockRestartHost } from "../src/mocksaferestart";
import { DiscordNotifier, NOTIFY_KINDS, type Item, type NotifyKind } from "../src/notify";
import { notificationsFor, type PushPrefs } from "../src/push";
import { emptyAgentState, SAFE_RESTART_STEPS, type AgentEvent, type AgentState, type LiveMessage, type SafeRestartRun, type SafeRestartStepState } from "../src/types";

const URL_ = "https://discord.example/api/webhooks/123/s3cr3t-token";
const T0 = Date.parse("2026-10-09T18:00:00Z");

// ---- a run as the agent publishes it ------------------------------------------

function run(edit: Partial<SafeRestartRun> = {}, steps: Partial<Record<string, SafeRestartStepState>> = {}): SafeRestartRun {
  return {
    id: "20261009-180000",
    actor: "Jarl",
    request: { whenEmpty: false, deadlineMinutes: 0, warnMinutes: 5, locale: "en" },
    state: "running",
    step: "",
    steps: SAFE_RESTART_STEPS.map((name) => ({ name, state: steps[name] ?? "pending" })),
    startedAt: new Date(T0).toISOString(),
    forced: false,
    warned: false,
    ...edit,
  };
}

let seq = 0;
const ev = (type: AgentEvent["type"], data: Record<string, unknown>): AgentEvent => {
  seq++;
  return { seq, ts: new Date(T0 + seq * 1000).toISOString(), type, data };
};
const step = (s: string, result: string, r: SafeRestartRun) => ev("restart_run", { step: s, result, actor: r.actor, run: r });
const live = (e: AgentEvent): LiveMessage => ({ type: "event", event: e });

function state(edit: (s: AgentState) => void = () => undefined): LiveMessage {
  const s = emptyAgentState();
  s.server.status = "running";
  s.server.joinCode = "482915";
  edit(s);
  return { type: "state", state: s, online: true };
}

const running: DiscordNotifier[] = [];
afterEach(() => {
  for (const n of running.splice(0)) n.stop();
});

function discord(kinds: readonly NotifyKind[] = NOTIFY_KINDS, first: LiveMessage = state()) {
  const contents: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    contents.push((JSON.parse(init.body as string) as { content: string }).content);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const n = new DiscordNotifier({ url: URL_, kinds, locale: "en", fetchImpl, clock: () => T0 + seq * 1000, log: () => undefined, coalesceMs: 10, serverHoldMs: 20 });
  running.push(n);
  n.handle(first);
  return { n, contents };
}

const settle = async (n: DiscordNotifier) => {
  await Bun.sleep(60);
  await n.idle();
};

/** The events of a run that went through a countdown, the game down and up with a new code. */
function fullRun(end: "done" | "failed", edit: Partial<SafeRestartRun> = {}): AgentEvent[] {
  const r = run();
  return [
    step("begin", "running", r),
    step("countdown", "running", { ...r, step: "countdown", restartAt: new Date(T0 + 300_000).toISOString() }),
    ev("admin", { actor: "Jarl", command: "broadcast", result: "ok", text: "The server restarts in 5 min." }),
    step("countdown", "ok", r),
    step("stop", "running", r),
    ev("server_state", { status: "stopping" }),
    ev("server_state", { status: "stopped" }),
    step("stop", "ok", r),
    ev("server_state", { status: "starting" }),
    ev("join_code", { code: "771203" }),
    ev("server_state", { status: "running" }),
    step("end", end, { ...r, state: end, joinCode: end === "done" ? "771203" : undefined, ...edit }),
  ];
}

describe("Discord news of a safe restart", () => {
  it("says the heads-up and the end with the new code, and nothing else", async () => {
    const { n, contents } = discord();
    for (const e of fullRun("done")) n.handle(live(e));
    await settle(n);
    expect(contents.join("\n")).toBe(["The server restarts in 5 min for a backup. Find a safe spot.", "The server is back after a safe restart. New join code: **771203**"].join("\n"));
  });

  it("reports a failure with the backup kept, and the new code the game came up with", async () => {
    const { n, contents } = discord();
    for (const e of fullRun("failed", { error: "verify: no complete world", archive: "pre-restart-20261009-180500.zip" })) n.handle(live(e));
    await settle(n);
    const all = contents.join("\n");
    expect(all).toContain("The safe restart failed (verify: no complete world). The backup is kept as pre-restart-20261009-180500.zip.");
    expect(all).toContain("New join code: **771203**");
    expect(all).not.toContain("Server stopped");
  });

  it("calls off only what it announced", async () => {
    const a = discord();
    const r = run();
    for (const e of [step("begin", "running", r), step("countdown", "running", r), step("countdown", "cancelled", r), step("end", "cancelled", { ...r, state: "cancelled" })]) a.n.handle(live(e));
    await settle(a.n);
    expect(a.contents.join("\n")).toBe("The server restarts in 5 min for a backup. Find a safe spot.\nThe server restart is called off.");

    const b = discord();
    const w = run({ request: { whenEmpty: true, deadlineMinutes: 0, warnMinutes: 5 } });
    for (const e of [step("begin", "running", w), step("wait", "running", w), step("wait", "cancelled", w), step("end", "cancelled", { ...w, state: "cancelled" })]) b.n.handle(live(e));
    await settle(b.n);
    expect(b.contents).toEqual([]);
  });

  it("says the server goes down now when nobody was there to count down for", async () => {
    const { n, contents } = discord();
    const r = run();
    for (const e of [step("begin", "running", r), step("countdown", "skipped", r), step("stop", "running", r)]) n.handle(live(e));
    await settle(n);
    expect(contents).toEqual(["The server restarts now for a backup. Back in a few minutes."]);
  });

  it("holds the server news of a run that began before this boot", async () => {
    const { n, contents } = discord(NOTIFY_KINDS, state((s) => (s.safeRestart = run({ step: "countdown" }))));
    for (const e of fullRun("done").slice(4)) n.handle(live(e));
    await settle(n);
    expect(contents).toEqual(["The server is back after a safe restart. New join code: **771203**"]);
  });

  it("lets news through while the run only waits, and lifts its hold when the agent forgets the run", async () => {
    const a = discord();
    const w = run({ request: { whenEmpty: true, deadlineMinutes: 0, warnMinutes: 5 } });
    for (const e of [step("begin", "running", w), step("wait", "running", w), ev("join_code", { code: "555111" })]) a.n.handle(live(e));
    await settle(a.n);
    expect(a.contents).toEqual(["New join code: **555111**"]);

    const b = discord();
    const r = run({ step: "stop" });
    for (const e of [step("begin", "running", r), step("countdown", "skipped", r), step("stop", "running", r)]) b.n.handle(live(e));
    // The agent restarted: its state has no run, and no end ever comes.
    b.n.handle(state((s) => (s.safeRestart = null)));
    b.n.handle(live(ev("join_code", { code: "555222" })));
    await settle(b.n);
    expect(b.contents.join("\n")).toContain("New join code: **555222**");
  });

  it("tells what changed under a hold the agent never ended", async () => {
    const { n, contents } = discord();
    const r = run({ step: "stop" });
    for (const e of [step("begin", "running", r), step("countdown", "skipped", r), step("stop", "running", r), ev("server_state", { status: "stopped" }), ev("join_code", { code: "555333" })]) n.handle(live(e));
    // The agent restarted with the game down: no run, no end, a new code meanwhile.
    n.handle(
      state((s) => {
        s.safeRestart = null;
        s.server.status = "stopped";
        s.server.joinCode = "555333";
      }),
    );
    await settle(n);
    const all = contents.join("\n");
    expect(all).toContain("Server stopped");
    expect(all).toContain("New join code: **555333**");
  });

  it("files the news under the Discord kinds: a failure is a failure, the rest is server news", async () => {
    const f = discord(["failure"]);
    for (const e of fullRun("failed", { error: "start: SPAWN_ERROR" })) f.n.handle(live(e));
    await settle(f.n);
    expect(f.contents).toEqual(["The safe restart failed (start: SPAWN\\_ERROR)."]);
    const s = discord(["server"]);
    for (const e of fullRun("done")) s.n.handle(live(e));
    await settle(s.n);
    expect(s.contents.join("\n").split("\n")).toHaveLength(2);
  });
});

describe("phone push of a safe restart", () => {
  const prefs = (p: Partial<PushPrefs> = {}): PushPrefs => ({ kinds: ["server", "failure"], firstJoinOnly: false, quiet: null, timeZone: "UTC", locale: "en", ...p });
  const ctx = { joinCode: "482915" };
  const one = (it: Item, p?: Partial<PushPrefs>) => notificationsFor([it], prefs(p), ctx, { sent: [] }, T0, 60_000);

  it("tells the heads-up, the server back with its code, and a failure", () => {
    expect(one({ kind: "restart", phase: "warning", minutes: 5 })).toEqual([{ title: "Server restart", body: "In 5 min, for a backup. Find a safe spot.", tag: "server", url: "/" }]);
    expect(one({ kind: "restart", phase: "warning", minutes: 5 }, { locale: "pl" })[0]!.body).toBe("Za 5 min, na kopię świata. Znajdźcie bezpieczne miejsce.");
    // Going down now (nobody on): the server-up a minute later is enough for a phone.
    expect(one({ kind: "restart", phase: "warning", minutes: 0 })).toEqual([]);
    expect(one({ kind: "restart", phase: "done", code: "771203" })).toEqual([{ title: "The server is up", body: "Join code: 771203", tag: "server", url: "/" }]);
    expect(one({ kind: "restart", phase: "failed", error: "x", archive: "" })).toEqual([{ title: "Something failed", body: "The safe restart failed", tag: "failure", url: "/#settings" }]);
    expect(one({ kind: "restart", phase: "cancelled" })[0]!.body).toBe("The restart is called off");
  });

  it("follows the device's kinds", () => {
    expect(one({ kind: "restart", phase: "warning", minutes: 5 }, { kinds: ["failure"] })).toEqual([]);
    expect(one({ kind: "restart", phase: "failed", error: "x", archive: "" }, { kinds: ["server"] })).toEqual([]);
  });
});

describe("applyEvent", () => {
  it("keeps the run every event carries", () => {
    const s = emptyAgentState();
    const r = run({ step: "backup" });
    expect(applyEvent(s, step("backup", "running", r)).safeRestart).toEqual(r);
    expect(applyEvent(s, ev("restart_run", { step: "x" }))).toBe(s);
  });
});

// ---- the mock ------------------------------------------------------------------

/** A fake agent for the mock run: timers run when the test steps the clock. */
function host(players: string[] = []) {
  let now = T0;
  const queue: { at: number; fn: () => void }[] = [];
  const events: Record<string, unknown>[] = [];
  const said: string[] = [];
  const backups: string[] = [];
  let busy = false;
  let status = "running";
  const h: MockRestartHost = {
    clock: () => now,
    players: () => [...players],
    running: () => status === "running",
    leave: (name) => players.splice(players.indexOf(name), 1),
    bridgeOn: () => status === "running",
    broadcast: (text) => void said.push(text),
    save: () => undefined,
    setStatus: (s) => void (status = s),
    boot: () => void (status = "running"),
    newCode: () => "771203",
    lock: () => (busy ? false : (busy = true)),
    unlock: () => void (busy = false),
    addBackup: (b) => void backups.push(b.name),
    worldBytes: () => 48_000_000,
    emit: (_type, data) => void events.push(data),
    after: (ms, fn) => void queue.push({ at: now + ms, fn }),
  };
  /** Runs everything due within ms, in time order. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      queue.sort((a, b) => a.at - b.at);
      const next = queue[0];
      if (!next || next.at > end) break;
      queue.shift();
      now = next.at;
      next.fn();
    }
    now = end;
  };
  const steps = () => events.map((e) => `${e.step}:${e.result}`);
  return { h, advance, events, steps, said, backups, players, isBusy: () => busy };
}

describe("MockSafeRestart", () => {
  it("runs every step like the agent", () => {
    const t = host();
    const m = new MockSafeRestart(t.h);
    expect(m.start({ whenEmpty: false, deadlineMinutes: 0, warnMinutes: 5 }, "Jarl").status).toBe(202);
    t.advance(60_000);
    expect(t.steps().join(",")).toBe(
      "begin:running,wait:skipped,countdown:skipped,save:running,save:ok,stop:running,stop:ok,backup:running,backup:ok,verify:running,verify:ok,start:running,start:ok,recover:running,recover:ok,end:done",
    );
    const v = m.view()!;
    expect(v).toMatchObject({ state: "done", joinCode: "771203" });
    expect(v.archive).toMatch(/^pre-restart-\d{8}-\d{6}\.zip$/);
    expect(t.backups).toEqual([v.archive!]);
    expect(t.isBusy()).toBe(false);
  });

  it("waits for the server to empty, counts down with players on, and can be cancelled", () => {
    const t = host(["Ragnar", "Freya"]);
    const m = new MockSafeRestart(t.h);
    m.start({ whenEmpty: true, deadlineMinutes: 0, warnMinutes: 1 }, "Jarl");
    t.advance(1_000);
    expect(m.waiting()).toBe(true);
    t.advance(15_000);
    expect(t.players).toEqual([]);
    expect(m.view()!.steps.find((s) => s.name === "wait")).toMatchObject({ state: "ok", reason: "empty" });

    const c = host(["Bjorn"]);
    const n = new MockSafeRestart(c.h, "ok");
    n.start({ whenEmpty: false, deadlineMinutes: 0, warnMinutes: 1 }, "Jarl");
    c.advance(MOCK_MINUTE_MS / 2);
    expect(c.said[0]).toBe("The server restarts in 1 min. Find a safe spot.");
    expect(n.cancel("Astrid").status).toBe(200);
    c.advance(1_000);
    expect(n.view()).toMatchObject({ state: "cancelled", cancelledBy: "Astrid" });
    expect(c.said.at(-1)).toBe("The server restart is called off.");
    expect(n.cancel("Astrid").status).toBe(404);
  });

  it("forces the countdown at the deadline", () => {
    const t = host(["Ragnar"]);
    // Nobody leaves in this test's evening.
    t.h.leave = () => undefined;
    const m = new MockSafeRestart(t.h);
    m.start({ whenEmpty: true, deadlineMinutes: 1, warnMinutes: 1 }, "Jarl");
    t.advance(MOCK_MINUTE_MS + 500);
    expect(m.view()).toMatchObject({ forced: true, step: "countdown" });
  });

  it("fails a verify like the agent: the game comes back, the run fails, the copy stays", () => {
    const t = host();
    const m = new MockSafeRestart(t.h, "fail-verify");
    m.start({ whenEmpty: false, deadlineMinutes: 0, warnMinutes: 0 }, "Jarl");
    t.advance(60_000);
    const v = m.view()!;
    expect(v.state).toBe("failed");
    expect(v.steps.find((s) => s.name === "verify")!.state).toBe("error");
    expect(v.steps.find((s) => s.name === "start")!.state).toBe("ok");
    expect(v.error).toContain("verify");
    expect(t.backups).toHaveLength(1);
  });

  it("fails each other step as the agent would", () => {
    for (const [mode, stepName, state, run] of [
      ["fail-save", "save", "warn", "done"],
      ["fail-backup", "backup", "error", "failed"],
      ["fail-start", "start", "error", "failed"],
      ["fail-recover", "recover", "error", "failed"],
    ] as const) {
      const t = host();
      const m = new MockSafeRestart(t.h, mode);
      m.start({ whenEmpty: false, deadlineMinutes: 0, warnMinutes: 0 }, "Jarl");
      t.advance(60_000);
      const v = m.view()!;
      expect(v.state, mode).toBe(run);
      expect(v.steps.find((s) => s.name === stepName)!.state, mode).toBe(state);
      expect(t.isBusy(), mode).toBe(false);
    }
  });

  it("refuses a second run and a cancel past the save", () => {
    const t = host();
    const m = new MockSafeRestart(t.h);
    m.start({ whenEmpty: false, deadlineMinutes: 0, warnMinutes: 0 }, "Jarl");
    expect(m.start({ whenEmpty: false, deadlineMinutes: 0, warnMinutes: 0 }, "Jarl").status).toBe(409);
    t.advance(500);
    expect(m.cancel("Jarl").status).toBe(409);
    expect(m.start({ whenEmpty: false, deadlineMinutes: 0, warnMinutes: 99 }, "Jarl").status).toBe(409);
  });
});
