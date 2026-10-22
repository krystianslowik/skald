import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentSource } from "../src/agent";
import { createApp } from "../src/app";
import { createSession, RateLimiter, SESSION_COOKIE } from "../src/auth";
import { HistoryStore } from "../src/db";
import { mockCompat } from "../src/mockcompat";
import { Hub } from "../src/hub";
import { silentLog } from "../src/log";
import { DiscordNotifier, NOTIFY_KINDS, type Item } from "../src/notify";
import { isQuiet, notificationsFor, pushResetKey, parseEndpoint, parsePrefs, PUSH_TEST_COOLDOWN_MS, PushService, PushStore, type PushPrefs } from "../src/push";
import { emptyAgentState, type AgentEvent, type AgentState, type LiveMessage } from "../src/types";
import { decryptPush, newBrowserKeys, type BrowserKeys } from "./pushhelpers";

const T0 = Date.parse("2026-10-09T18:00:00Z");
const FCM = "https://fcm.googleapis.com/fcm/send/device-";

const prefs = (p: Partial<PushPrefs> = {}): PushPrefs => ({ kinds: ["join", "server", "boss", "raid", "death", "failure", "update"], firstJoinOnly: false, quiet: null, timeZone: "UTC", locale: "en", ...p });

describe("parseEndpoint", () => {
  it("takes the push services browsers use, and nothing else", () => {
    expect(parseEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe("https://fcm.googleapis.com/fcm/send/abc");
    expect(parseEndpoint("https://web.push.apple.com/QGx")).not.toBeNull();
    expect(parseEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).not.toBeNull();
    expect(parseEndpoint("https://db5p.notify.windows.com/w/?token=x")).not.toBeNull();
    for (const bad of [
      "http://fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user@fcm.googleapis.com/x",
      "https://evil.example/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example/x",
      "https://notify.windows.com/x",
      "https://127.0.0.1/x",
      "http://127.0.0.1:9000/x",
      "file:///etc/passwd",
      `https://fcm.googleapis.com/${"a".repeat(1100)}`,
      42,
    ]) {
      expect(parseEndpoint(bad)).toBeNull();
    }
  });

  it("takes a local endpoint only when the mock allows it", () => {
    expect(parseEndpoint("http://127.0.0.1:9000/sink", true)).toBe("http://127.0.0.1:9000/sink");
    expect(parseEndpoint("http://localhost:9000/sink", true)).toBeNull();
  });
});

describe("parsePrefs", () => {
  it("keeps known kinds in order and checks every field", () => {
    expect(parsePrefs({ kinds: ["raid", "join"], firstJoinOnly: true, quiet: { from: "22:00", to: "07:30" }, timeZone: "Europe/Warsaw", locale: "pl" })).toEqual({
      kinds: ["join", "raid"],
      firstJoinOnly: true,
      quiet: { from: "22:00", to: "07:30" },
      timeZone: "Europe/Warsaw",
      locale: "pl",
    });
    expect(parsePrefs({ ...prefs(), kinds: ["leave"] })).toBe("unknown kind");
    expect(parsePrefs({ ...prefs(), quiet: { from: "24:00", to: "07:00" } })).toBe("quiet hours must be HH:MM");
    expect(parsePrefs({ ...prefs(), timeZone: "Mars/Olympus" })).toBe("unknown time zone");
    expect(parsePrefs({ ...prefs(), locale: "de" })).toBe("unknown locale");
    expect(parsePrefs({ ...prefs(), firstJoinOnly: "yes" })).toBe("firstJoinOnly must be true or false");
    expect(parsePrefs(null)).toBe("prefs missing");
  });
});

describe("isQuiet", () => {
  const at = (iso: string) => Date.parse(iso);
  it("reads the hours in the device's zone and runs past midnight", () => {
    const night = { quiet: { from: "22:00", to: "07:00" }, timeZone: "Europe/Warsaw" };
    // 21:30 UTC is 23:30 in Warsaw (CEST).
    expect(isQuiet(night, at("2026-10-09T21:30:00Z"))).toBe(true);
    expect(isQuiet(night, at("2026-10-09T04:59:00Z"))).toBe(true);
    expect(isQuiet(night, at("2026-10-09T05:00:00Z"))).toBe(false);
    expect(isQuiet(night, at("2026-10-09T18:00:00Z"))).toBe(false);
    const lunch = { quiet: { from: "12:00", to: "13:00" }, timeZone: "UTC" };
    expect(isQuiet(lunch, at("2026-10-09T12:30:00Z"))).toBe(true);
    expect(isQuiet(lunch, at("2026-10-09T13:00:00Z"))).toBe(false);
    expect(isQuiet({ quiet: { from: "08:00", to: "08:00" }, timeZone: "UTC" }, at("2026-10-09T08:00:00Z"))).toBe(false);
    expect(isQuiet({ quiet: null, timeZone: "UTC" }, at("2026-10-09T08:00:00Z"))).toBe(false);
  });
});

describe("notificationsFor", () => {
  const ctx = { joinCode: "482915" };
  const join = (name: string, first = false): Item => ({ kind: "join", name, first });

  it("collapses joins into the newest notification while it is fresh", () => {
    const mem = { sent: [] };
    const a = notificationsFor([join("Ragnar", true)], prefs(), ctx, mem, T0, 60_000);
    expect(a).toEqual([{ title: "At the fire", body: "Ragnar arrives at the fire", tag: "join", url: "/" }]);
    const b = notificationsFor([join("Freya"), join("Bjorn")], prefs(), ctx, mem, T0 + 10_000, 60_000);
    expect(b[0]!.body).toBe("Ragnar, Freya, and Bjorn arrive at the fire");
    const c = notificationsFor([join("Astrid")], prefs(), ctx, mem, T0 + 20_000, 60_000);
    expect(c[0]!.body).toBe("Ragnar, Freya, and 2 more arrive at the fire");
    // Past the window it starts over.
    expect(notificationsFor([join("Ragnar")], prefs(), ctx, mem, T0 + 200_000, 60_000)[0]!.body).toBe("Ragnar arrives at the fire");
  });

  it("closes the group a fixed time after its first notification, and a first join starts a new one", () => {
    const mem = { sent: [] };
    notificationsFor([join("Ragnar", true)], prefs(), ctx, mem, T0, 60_000);
    notificationsFor([join("Freya")], prefs(), ctx, mem, T0 + 50_000, 60_000);
    // 70 s after the group's first notification: a new group, though the last one was 20 s ago.
    expect(notificationsFor([join("Bjorn")], prefs(), ctx, mem, T0 + 70_000, 60_000)[0]!.body).toBe("Bjorn arrives at the fire");
    // The fire went out and someone lit it again: whoever came before has left.
    expect(notificationsFor([join("Astrid", true)], prefs(), ctx, mem, T0 + 80_000, 60_000)[0]!.body).toBe("Astrid arrives at the fire");
  });

  it("with firstJoinOnly, tells only of the join that lit the fire", () => {
    const mem = { sent: [] };
    expect(notificationsFor([join("Freya")], prefs({ firstJoinOnly: true }), ctx, mem, T0, 60_000)).toEqual([]);
    expect(notificationsFor([join("Ragnar", true), join("Freya")], prefs({ firstJoinOnly: true }), ctx, mem, T0, 60_000)[0]!.body).toBe("Ragnar and Freya arrive at the fire");
  });

  it("gives the server coming up with the join code, and a new code on its own", () => {
    const up = notificationsFor([{ kind: "server", status: "running" }], prefs(), ctx, { sent: [] }, T0, 0);
    expect(up).toEqual([{ title: "The server is up", body: "Join code: 482915", tag: "server", url: "/" }]);
    const both = notificationsFor([{ kind: "join_code", code: "111222" }, { kind: "server", status: "running" }], prefs(), ctx, { sent: [] }, T0, 0);
    expect(both).toEqual([{ title: "The server is up", body: "Join code: 111222", tag: "server", url: "/" }]);
    const code = notificationsFor([{ kind: "join_code", code: "111222" }], prefs({ locale: "pl" }), ctx, { sent: [] }, T0, 0);
    expect(code).toEqual([{ title: "Nowy kod dołączenia", body: "Kod dołączenia: 111222", tag: "server", url: "/" }]);
    expect(notificationsFor([{ kind: "server", status: "stopped" }], prefs(), ctx, { sent: [] }, T0, 0)).toEqual([]);
  });

  it("names bosses, raids, failures and updates in the device's language, and only what it chose", () => {
    const items: Item[] = [
      { kind: "boss", key: "defeated_bonemass" },
      { kind: "raid", raid: "wolves" },
      { kind: "failure", what: "action", action: "backup", error: "disk full" },
      { kind: "failure", what: "admin", actor: "Bjorn", command: "kick", error: "x" },
      { kind: "version", version: "l-1.0.20" },
      { kind: "death", name: "Ragnar" },
      { kind: "leave", name: "Freya", ms: 1000 },
    ];
    const pl = notificationsFor(items, prefs({ locale: "pl" }), ctx, { sent: [] }, T0, 0);
    expect(pl.map((n) => [n.tag, n.body])).toEqual([
      ["death", "Ragnar pada w boju"],
      ["boss", "Pokonano: Kościoszlam"],
      ["raid", "Polują na ciebie…"],
      ["failure", "Kopia świata: nie powiodło się"],
      ["update", "Gra zaktualizowana do 1.0.20"],
    ]);
    const some = notificationsFor(items, prefs({ kinds: ["boss"] }), ctx, { sent: [] }, T0, 0);
    expect(some).toEqual([{ title: "Boss defeated", body: "Bonemass defeated", tag: "boss", url: "/" }]);
  });

  it("opens a compatibility check at its details in the admin sheet, a plain update at the fire", () => {
    const check = mockCompat("fail", "l-1.0.20", 41, T0).result!;
    const [checked] = notificationsFor([{ kind: "compat", result: check, followUp: false }], prefs(), ctx, { sent: [] }, T0, 0);
    expect(checked).toMatchObject({ tag: "update", url: "/#admin/compat" });
    const [plain] = notificationsFor([{ kind: "version", version: "l-1.0.20" }], prefs(), ctx, { sent: [] }, T0, 0);
    expect(plain).toMatchObject({ tag: "update", url: "/" });
  });
});

// ---- the service, against a fake push service ----------------------------------

interface Delivered {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

function fakePushService(status: (url: string) => number = () => 201) {
  const calls: Delivered[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array });
    return new Response(null, { status: status(url) });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const stores: PushStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

async function service(fetchImpl: typeof fetch, o: { now?: () => number; rateMax?: number } = {}) {
  const store = new PushStore(":memory:");
  stores.push(store);
  const push = new PushService({ store, contact: "mailto:jarl@example.com", fetchImpl, clock: o.now ?? (() => T0), log: silentLog, rateMax: o.rateMax });
  await push.init();
  return { push, store };
}

async function subscribe(push: PushService, n: number, p: Partial<PushPrefs> = {}): Promise<BrowserKeys> {
  const ua = await newBrowserKeys();
  const res = await push.subscribe({ endpoint: `${FCM}${n}`, keys: ua.keys }, prefs(p));
  expect(res.ok).toBe(true);
  return ua;
}

describe("PushService", () => {
  it("adds the session column to a device table made before it", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE push_devices (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, prefs TEXT NOT NULL, created INTEGER NOT NULL, fails INTEGER NOT NULL DEFAULT 0)");
    const store = new PushStore(db);
    stores.push(store);
    const push = new PushService({ store, contact: "mailto:jarl@example.com", log: silentLog });
    await push.init();
    const ua = await newBrowserKeys();
    expect((await push.subscribe({ endpoint: `${FCM}1`, keys: ua.keys }, prefs(), "s1")).ok).toBe(true);
    push.forgetSession("s1");
    expect(store.count()).toBe(0);
  });

  it("moves a device to the session that saves it last, within that session's cap", async () => {
    const store = new PushStore(":memory:");
    stores.push(store);
    const push = new PushService({ store, contact: "mailto:jarl@example.com", log: silentLog, maxPerSession: 1 });
    await push.init();
    const a = await newBrowserKeys();
    const b = await newBrowserKeys();
    expect((await push.subscribe({ endpoint: `${FCM}1`, keys: a.keys }, prefs(), "A")).ok).toBe(true);
    expect((await push.subscribe({ endpoint: `${FCM}2`, keys: b.keys }, prefs(), "B")).ok).toBe(true);
    expect(await push.subscribe({ endpoint: `${FCM}1`, keys: a.keys }, prefs(), "B")).toMatchObject({ ok: false, error: "session_full" });
    push.forgetSession("A");
    expect(store.all().map((d) => d.endpoint)).toEqual([`${FCM}2`]);
  });

  it("makes VAPID keys once and keeps them", async () => {
    const store = new PushStore(":memory:");
    stores.push(store);
    const a = new PushService({ store, contact: "mailto:jarl@example.com", log: silentLog });
    await a.init();
    const b = new PushService({ store, contact: "mailto:jarl@example.com", log: silentLog });
    await b.init();
    expect(b.publicKey).toBe(a.publicKey);
    expect(store.getMeta("push.vapid")).toContain("privateJwk");
  });

  it("takes a safe restart's news for a device with only failures on", async () => {
    const net = fakePushService();
    const { push } = await service(net.fetchImpl);
    await subscribe(push, 1, { kinds: ["failure"] });
    expect(push.wants("restart")).toBe(true);
    expect(push.wants("server")).toBe(false);
  });

  it("sends each device its own encrypted notification, in its own language", async () => {
    const net = fakePushService();
    const { push } = await service(net.fetchImpl);
    const en = await subscribe(push, 1);
    const pl = await subscribe(push, 2, { locale: "pl", kinds: ["raid"] });
    expect(push.wants("join")).toBe(true);
    expect(push.wants("leave")).toBe(false);
    push.batch([{ kind: "join", name: "Ragnar" }, { kind: "raid", raid: "wolves" }], { joinCode: "" });
    await push.idle();
    const to = (n: number) => net.calls.filter((c) => c.url === `${FCM}${n}`);
    expect(to(1)).toHaveLength(2);
    expect(to(2)).toHaveLength(1);
    expect(JSON.parse(await decryptPush(to(2)[0]!.body, pl))).toEqual({ title: "Najazd", body: "Polują na ciebie…", tag: "raid", url: "/#saga" });
    const bodies = await Promise.all(to(1).map(async (c) => JSON.parse(await decryptPush(c.body, en)).body));
    expect(bodies.sort()).toEqual(["Ragnar arrives at the fire", "You are being hunted..."]);
    expect(to(1).map((c) => c.headers.Topic).sort()).toEqual(["join", "raid"]);
    expect(to(1)[0]!.headers.Authorization).toStartWith("vapid t=");
  });

  it("stays quiet in a device's quiet hours", async () => {
    const net = fakePushService();
    const { push } = await service(net.fetchImpl);
    await subscribe(push, 1, { quiet: { from: "17:00", to: "19:00" } });
    await subscribe(push, 2);
    push.batch([{ kind: "raid", raid: "wolves" }], { joinCode: "" });
    await push.idle();
    expect(net.calls.map((c) => c.url)).toEqual([`${FCM}2`]);
  });

  it("forgets a device the push service says is gone, and one that keeps being refused", async () => {
    const net = fakePushService((url) => (url.endsWith("1") ? 410 : 400));
    const { push, store } = await service(net.fetchImpl);
    await subscribe(push, 1);
    await subscribe(push, 2);
    push.batch([{ kind: "raid", raid: "wolves" }], { joinCode: "" });
    await push.idle();
    expect(store.all().map((d) => d.endpoint)).toEqual([`${FCM}2`]);
    expect(store.get(`${FCM}2`)!.fails).toBe(1);
    for (let i = 0; i < 9; i++) {
      push.batch([{ kind: "raid", raid: `r${i}` }], { joinCode: "" });
      await push.idle();
    }
    expect(store.count()).toBe(0);
    expect(push.wants("raid")).toBe(false);
  });

  it("follows both the panel password and the session secret", () => {
    const k = pushResetKey("hash-a", "secret-a");
    expect(pushResetKey("hash-a", "secret-a")).toBe(k);
    expect(pushResetKey("hash-b", "secret-a")).not.toBe(k);
    expect(pushResetKey("hash-a", "secret-b")).not.toBe(k);
    expect(k).not.toContain("secret");
  });

  it("forgets every device when the panel password changed", async () => {
    const store = new PushStore(":memory:");
    stores.push(store);
    const first = new PushService({ store, contact: "mailto:jarl@example.com", log: silentLog, resetKey: "a" });
    await first.init();
    const ua = await newBrowserKeys();
    await first.subscribe({ endpoint: `${FCM}1`, keys: ua.keys }, prefs());
    const same = new PushService({ store, contact: "mailto:jarl@example.com", log: silentLog, resetKey: "a" });
    await same.init();
    expect(store.count()).toBe(1);
    const changed = new PushService({ store, contact: "mailto:jarl@example.com", log: silentLog, resetKey: "b" });
    await changed.init();
    expect(store.count()).toBe(0);
    expect(changed.wants("join")).toBe(false);
    expect(changed.publicKey).toBe(first.publicKey);
  });

  it("logs a failure in the background instead of rejecting", async () => {
    const net = fakePushService(() => 400);
    const { push, store } = await service(net.fetchImpl);
    await subscribe(push, 1);
    // The database goes away under a delivery: the error must not escape as an unhandled rejection.
    const setFails = store.setFails.bind(store);
    store.setFails = () => {
      throw new Error("database is locked");
    };
    push.batch([{ kind: "raid", raid: "wolves" }], { joinCode: "" });
    await push.idle();
    store.setFails = setFails;
    expect(net.calls).toHaveLength(1);
  });

  it("forgets what it remembered about a device that is gone, so a new subscription starts clean", async () => {
    let status = 201;
    const net = fakePushService(() => status);
    const { push } = await service(net.fetchImpl);
    await subscribe(push, 1);
    expect(await push.test(`${FCM}1`)).toEqual({ ok: true });
    status = 410;
    push.batch([{ kind: "raid", raid: "wolves" }], { joinCode: "" });
    await push.idle();
    status = 201;
    await subscribe(push, 1);
    expect(await push.test(`${FCM}1`)).toEqual({ ok: true });
  });

  it("lets a join code expire within the hour at the push service, other news later", async () => {
    const net = fakePushService();
    const { push } = await service(net.fetchImpl);
    await subscribe(push, 1);
    push.batch([{ kind: "server", status: "running" }, { kind: "raid", raid: "wolves" }], { joinCode: "482915" });
    await push.idle();
    const ttl = Object.fromEntries(net.calls.map((c) => [c.headers.Topic, c.headers.TTL]));
    expect(ttl).toEqual({ server: "3600", raid: "21600" });
  });

  it("drops what goes past the rate limit", async () => {
    const net = fakePushService();
    const { push } = await service(net.fetchImpl, { rateMax: 2 });
    await subscribe(push, 1);
    for (let i = 0; i < 4; i++) push.batch([{ kind: "raid", raid: `r${i}` }], { joinCode: "" });
    await push.idle();
    expect(net.calls).toHaveLength(2);
  });

  it("sends a test to one device at most once per cooldown", async () => {
    const net = fakePushService();
    let now = T0;
    const { push } = await service(net.fetchImpl, { now: () => now });
    const ua = await subscribe(push, 1, { locale: "pl", quiet: { from: "00:00", to: "23:59" } });
    expect(await push.test(`${FCM}1`)).toEqual({ ok: true });
    expect(JSON.parse(await decryptPush(net.calls[0]!.body, ua)).body).toBe("Testowe powiadomienie. Powiadomienia działają na tym urządzeniu.");
    expect(await push.test(`${FCM}1`)).toEqual({ ok: false, error: "busy", retryAfter: 10 });
    now += PUSH_TEST_COOLDOWN_MS;
    expect(await push.test(`${FCM}1`)).toEqual({ ok: true });
    expect(await push.test(`${FCM}9`)).toEqual({ ok: false, error: "not_subscribed" });
  });

  it("refuses endpoints and keys it cannot use, and more devices than the cap", async () => {
    const { push } = await service(fakePushService().fetchImpl);
    const ua = await newBrowserKeys();
    expect((await push.subscribe({ endpoint: "https://evil.example/x", keys: ua.keys }, prefs())).ok).toBe(false);
    expect(await push.subscribe({ endpoint: `${FCM}1`, keys: { p256dh: "AAAA", auth: ua.keys.auth } }, prefs())).toMatchObject({ ok: false, error: "bad_keys" });
    const store = new PushStore(":memory:");
    stores.push(store);
    const small = new PushService({ store, contact: "mailto:jarl@example.com", log: silentLog, maxDevices: 1 });
    await small.init();
    expect((await small.subscribe({ endpoint: `${FCM}1`, keys: ua.keys }, prefs())).ok).toBe(true);
    expect(await small.subscribe({ endpoint: `${FCM}2`, keys: ua.keys }, prefs())).toMatchObject({ ok: false, error: "full" });
    // The same device changing its choice is not a new one.
    expect((await small.subscribe({ endpoint: `${FCM}1`, keys: ua.keys }, prefs({ kinds: ["boss"] }))).ok).toBe(true);
    expect(small.device(`${FCM}1`)!.kinds).toEqual(["boss"]);
  });
});

// ---- fed by the Discord notifier ----------------------------------------------

const ev = (seq: number, type: AgentEvent["type"], data: Record<string, unknown>, at = T0 + seq * 1000): AgentEvent => ({ seq, ts: new Date(at).toISOString(), type, data });
const live = (e: AgentEvent): LiveMessage => ({ type: "event", event: e });
function state(edit: (s: AgentState) => void = () => undefined): LiveMessage {
  const s = emptyAgentState();
  s.server.status = "running";
  s.server.joinCode = "482915";
  edit(s);
  return { type: "state", state: s, online: true };
}
const withBosses = (name: string, defeated: string[]) =>
  state((s) => {
    s.world.meta = { name, seedName: "x", seed: 1, worldGenVersion: 2, netTime: 0, day: 0, savedAt: "", bosses: ["defeated_eikthyr", "defeated_gdking", "defeated_bonemass"].map((key) => ({ key, defeated: defeated.includes(key) })) };
  });

describe("the notifier's sinks", () => {
  const running: DiscordNotifier[] = [];
  afterEach(() => {
    for (const n of running.splice(0)) n.stop();
  });

  function wired(url = "") {
    let now = T0;
    const discord: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      discord.push(JSON.parse(init.body as string).content);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const n = new DiscordNotifier({ url, kinds: NOTIFY_KINDS, locale: "en", fetchImpl, clock: () => now, log: () => undefined, sleep: async () => undefined, coalesceMs: 20, serverHoldMs: 30 });
    running.push(n);
    const batches: Item[][] = [];
    let wanted = new Set<string>(["join", "boss", "raid", "join_code"]);
    n.addSink({ wants: (k) => wanted.has(k), batch: (items) => void batches.push([...items]) });
    return { n, discord, batches, at: (ms: number) => (now = T0 + ms), want: (k: string[]) => (wanted = new Set(k)) };
  }

  it("get the news while Discord is off, coalesced the same way", async () => {
    const w = wired();
    w.n.handle(state());
    w.n.handle(live(ev(1, "player_join", { name: "Ragnar" })));
    w.n.handle(live(ev(2, "player_join", { name: "Freya" })));
    w.n.handle(live(ev(3, "death", { name: "Ragnar" })));
    await Bun.sleep(60);
    expect(w.discord).toEqual([]);
    expect(w.batches).toEqual([
      [
        { kind: "join", name: "Ragnar", key: "Ragnar", first: true },
        { kind: "join", name: "Freya", key: "Freya", first: false },
      ],
    ]);
  });

  it("see a boss turn defeated between two states of the same world, not the baseline or another world", async () => {
    const w = wired();
    w.n.handle(withBosses("Midgard", ["defeated_eikthyr"]));
    w.n.handle(withBosses("Midgard", ["defeated_eikthyr", "defeated_gdking"]));
    w.n.handle(withBosses("Asgard", ["defeated_eikthyr", "defeated_gdking", "defeated_bonemass"]));
    w.n.handle(state((s) => (s.world.meta = null)));
    w.n.handle(withBosses("Asgard", ["defeated_eikthyr", "defeated_gdking", "defeated_bonemass"]));
    await Bun.sleep(30);
    expect(w.batches).toEqual([[{ kind: "boss", key: "defeated_gdking" }]]);
  });

  it("keep their share when the webhook changes, while Discord drops its own", async () => {
    const w = wired("https://discord.example/api/webhooks/1/a");
    w.n.handle(state());
    w.n.handle(live(ev(1, "player_join", { name: "Bjorn" })));
    w.n.configure({ url: "https://discord.example/api/webhooks/2/b", kinds: NOTIFY_KINDS });
    await Bun.sleep(60);
    await w.n.idle();
    expect(w.discord).toEqual([]);
    expect(w.batches).toEqual([[{ kind: "join", name: "Bjorn", key: "Bjorn", first: true }]]);
  });

  it("count a join as the first again once a state shows nobody online, though the leave was lost", async () => {
    const w = wired();
    w.n.handle(state((s) => (s.players = [{ name: "Ragnar", since: new Date(T0 - 60_000).toISOString() }])));
    w.n.handle(state((s) => (s.players = [])));
    w.n.handle(live(ev(1, "player_join", { name: "Freya" })));
    await Bun.sleep(60);
    expect(w.batches).toEqual([[{ kind: "join", name: "Freya", key: "Freya", first: true }]]);
  });

  it("are not woken for kinds no device wants", async () => {
    const w = wired();
    w.want([]);
    w.n.handle(state());
    w.n.handle(live(ev(1, "raid", { name: "wolves" })));
    await Bun.sleep(30);
    expect(w.batches).toEqual([]);
  });
});

// ---- routes ---------------------------------------------------------------------

describe("/api/push", () => {
  const agent = {} as AgentSource;
  async function app(o: { pushLimiter?: RateLimiter } = {}) {
    const net = fakePushService();
    const { push, store } = await service(net.fetchImpl);
    const a = createApp({ sessionSecret: "secret", passwordHash: "x", secureCookie: true, agent, hub: new Hub(agent, new HistoryStore(":memory:")), metrics: async () => null, push, log: silentLog, trustedIpHeader: "CF-Connecting-IP", pushLimiter: o.pushLimiter });
    let cookie = `${SESSION_COOKIE}=${createSession("secret")}`;
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      a.request(path, { method, headers: { Cookie: cookie, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const newSession = () => (cookie = `${SESSION_COOKIE}=${createSession("secret")}`);
    return { a, call, push, net, store, newSession };
  }

  const put = async (call: Awaited<ReturnType<typeof app>>["call"], n: number, headers: Record<string, string> = {}) =>
    call("PUT", "/api/push", { subscription: { endpoint: `${FCM}${n}`, keys: (await newBrowserKeys()).keys }, prefs: prefs() }, headers);

  it("limits subscribing and tests per client address", async () => {
    const { call } = await app({ pushLimiter: new RateLimiter(3, 60_000, 60_000) });
    for (let i = 0; i < 3; i++) expect((await put(call, i, { "CF-Connecting-IP": "203.0.113.7" })).status).toBe(200);
    const limited = await put(call, 9, { "CF-Connecting-IP": "203.0.113.7" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await call("POST", "/api/push/test", { endpoint: `${FCM}0` }, { "CF-Connecting-IP": "203.0.113.7" })).status).toBe(429);
    // Another address is not held by it.
    expect((await put(call, 9, { "CF-Connecting-IP": "203.0.113.8" })).status).toBe(200);
  });

  it("does not count a known device changing its choice toward the limit", async () => {
    const { call } = await app({ pushLimiter: new RateLimiter(2, 60_000, 60_000) });
    const keys = (await newBrowserKeys()).keys;
    const save = () => call("PUT", "/api/push", { subscription: { endpoint: `${FCM}1`, keys }, prefs: prefs() }, { "CF-Connecting-IP": "203.0.113.7" });
    for (let i = 0; i < 6; i++) expect((await save()).status).toBe(200);
    expect((await put(call, 2, { "CF-Connecting-IP": "203.0.113.7" })).status).toBe(200);
  });

  it("lets one session hold only a few devices, and signing out forgets them", async () => {
    const { a, call, store, newSession } = await app();
    for (let i = 0; i < 5; i++) expect((await put(call, i)).status).toBe(200);
    const sixth = await put(call, 5);
    expect(sixth.status).toBe(409);
    expect(((await sixth.json()) as { error: string }).error).toBe("session_full");
    // Changing an existing device's choice is not a new device.
    expect((await put(call, 4)).status).toBe(200);
    newSession();
    expect((await put(call, 5)).status).toBe(200);
    expect(store.count()).toBe(6);
    expect((await call("POST", "/api/logout")).status).toBe(200);
    expect(store.all().map((d) => d.endpoint)).toEqual([`${FCM}0`, `${FCM}1`, `${FCM}2`, `${FCM}3`, `${FCM}4`]);
    expect((await a.request("/api/logout", { method: "POST" })).status).toBe(200);
  });

  it("refuses bodies over 8 KiB", async () => {
    const { call } = await app();
    const res = await call("PUT", "/api/push", { subscription: { endpoint: `${FCM}1`, keys: { p256dh: "x".repeat(9000), auth: "a" } }, prefs: prefs() });
    expect(res.status).toBe(413);
  });

  it("needs a signed-in session", async () => {
    const { a } = await app();
    expect((await a.request("/api/push")).status).toBe(401);
    expect((await a.request("/api/push", { method: "PUT", body: "{}" })).status).toBe(401);
  });

  it("subscribes, reads back, tests and unsubscribes one device", async () => {
    const { call, net } = await app();
    const info = (await (await call("GET", "/api/push")).json()) as { publicKey: string; kinds: string[] };
    expect(info.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(info.kinds).toContain("boss");
    const ua = await newBrowserKeys();
    const sub = { endpoint: `${FCM}1`, keys: ua.keys };
    expect((await call("PUT", "/api/push", { subscription: sub, prefs: prefs({ kinds: ["raid"] }) })).status).toBe(200);
    expect(await (await call("POST", "/api/push/device", { endpoint: sub.endpoint })).json()).toEqual({ ok: true, prefs: prefs({ kinds: ["raid"] }) });
    expect((await call("POST", "/api/push/test", { endpoint: sub.endpoint })).status).toBe(200);
    expect(net.calls).toHaveLength(1);
    const again = await call("POST", "/api/push/test", { endpoint: sub.endpoint });
    expect(again.status).toBe(429);
    expect(again.headers.get("Retry-After")).toBe("10");
    expect((await call("DELETE", "/api/push", { endpoint: sub.endpoint })).status).toBe(200);
    expect(await (await call("POST", "/api/push/device", { endpoint: sub.endpoint })).json()).toEqual({ ok: true, prefs: null });
    expect((await call("POST", "/api/push/test", { endpoint: sub.endpoint })).status).toBe(404);
  });

  it("refuses bad input and other origins", async () => {
    const { call } = await app();
    const ua = await newBrowserKeys();
    expect((await call("PUT", "/api/push", { subscription: { endpoint: `${FCM}1`, keys: ua.keys }, prefs: { kinds: ["nope"] } })).status).toBe(400);
    expect((await call("PUT", "/api/push", { subscription: { endpoint: "http://10.0.0.1/x", keys: ua.keys }, prefs: prefs() })).status).toBe(400);
    expect((await call("PUT", "/api/push", "not json")).status).toBe(400);
    const cross = await call("PUT", "/api/push", { subscription: { endpoint: `${FCM}1`, keys: ua.keys }, prefs: prefs() }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
  });
});
