import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createSession, SESSION_COOKIE, upgradeLive } from "../src/auth";
import type { AgentSource } from "../src/agent";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { liveSocket, liveSocketData, type LiveSocketData } from "../src/live";
import { emptyAgentState, type AgentEvent, type LiveMessage } from "../src/types";

const SECRET = "secret";

// The same glue as server.ts: /live is authenticated before the upgrade.
const server = Bun.serve<object>({
  port: 0,
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/live") return upgradeLive(req, SECRET, () => srv.upgrade(req, { data: {} }));
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.send("hello");
    },
    message() {},
  },
});
afterAll(() => server.stop(true));

const http = `http://localhost:${server.port}/live`;
const ws = `ws://localhost:${server.port}/live`;

describe("/live upgrade", () => {
  it("is 401 without a session, with a bad one and with a malformed cookie", async () => {
    for (const cookie of [undefined, `${SESSION_COOKIE}=garbage`, `${SESSION_COOKIE}=%E0%A4%A`, `${SESSION_COOKIE}=%`]) {
      const res = await fetch(http, { headers: { Upgrade: "websocket", Connection: "Upgrade", ...(cookie ? { Cookie: cookie } : {}) } });
      expect([cookie, res.status]).toEqual([cookie, 401]);
    }
  });

  it("upgrades a signed-in client", async () => {
    const cookie = `${SESSION_COOKIE}=${createSession(SECRET)}`;
    const sock = new WebSocket(ws, { headers: { Cookie: cookie } });
    const first = await new Promise<string>((resolve, reject) => {
      sock.onmessage = (e) => resolve(String(e.data));
      sock.onerror = () => reject(new Error("socket error"));
    });
    expect(first).toBe("hello");
    sock.close();
  });

  it("is 400 for a signed-in request that is not an upgrade", async () => {
    const res = await fetch(http, { headers: { Cookie: `${SESSION_COOKIE}=${createSession(SECRET)}` } });
    expect(res.status).toBe(400);
  });
});

/** An agent that only records watch calls; the hub is driven through ingest(). */
function watchAgent(watches: boolean[]): AgentSource {
  const notFound = async () => new Response(null, { status: 404 });
  return {
    async getState() {
      return emptyAgentState();
    },
    async getLogs() {
      return [];
    },
    async action() {
      return { status: 200, body: { ok: true, message: "" } };
    },
    backup: notFound,
    async stream(_since, _on, signal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    },
    async settings() {
      return { status: 404, body: {} };
    },
    async map() {
      return { status: 404, etag: null, body: null };
    },
    asset: notFound,
    pieces: notFound,
    nature: notFound,
    async bridge() {
      return { status: 404, body: {} };
    },
    async tools() {
      return { status: 404, body: {} };
    },
    async watchPositions(on) {
      watches.push(on);
    },
  };
}

const pos = (x: number): AgentEvent => ({
  seq: 0,
  ts: new Date(1_000_000 + x).toISOString(),
  type: "positions",
  data: { t: x, players: [{ name: "Ragnar", platform: "xbox", x, z: 0, health: 1, maxHealth: 2 }] },
});

class FakeSocket {
  sent: LiveMessage[] = [];
  constructor(public data: LiveSocketData) {}
  send(s: string) {
    this.sent.push(JSON.parse(s) as LiveMessage);
  }
  positions() {
    return this.sent.filter((m) => m.type === "positions");
  }
}

/** Lease calls run one after another on promises. */
const flush = () => Bun.sleep(5);
const socket = (path: string) => new FakeSocket(liveSocketData(new URL(`http://x${path}`)));
const SUB = JSON.stringify({ type: "subscribe", topic: "positions" });
const UNSUB = JSON.stringify({ type: "unsubscribe", topic: "positions" });

describe("live positions per socket", () => {
  let hub: Hub | null = null;
  afterEach(() => hub?.stop());
  const setup = (positionsRenewMs?: number) => {
    const watches: boolean[] = [];
    hub = new Hub(watchAgent(watches), new HistoryStore(":memory:"), { positionsRenewMs });
    return { hub, watches, ws: liveSocket(hub) };
  };

  it("sends positions only to sockets that subscribed", () => {
    const { hub, ws } = setup();
    const map = socket("/live?topics=");
    const fire = socket("/live?topics=");
    ws.open(map);
    ws.open(fire);
    ws.message(map, SUB);
    hub.ingest("e", pos(1));
    expect(map.positions()).toHaveLength(1);
    expect(fire.positions()).toHaveLength(0);
    // Both still get everything else.
    hub.ingest("e", { seq: 1, ts: new Date(1_000_000).toISOString(), type: "death", data: { name: "Ragnar" } });
    expect(map.sent.some((m) => m.type === "event")).toBe(true);
    expect(fire.sent.some((m) => m.type === "event")).toBe(true);
  });

  it("stops sending after unsubscribe", async () => {
    const { hub, ws } = setup();
    const map = socket("/live?topics=positions");
    ws.open(map);
    hub.ingest("e", pos(1));
    expect(map.positions()).toHaveLength(1);
    ws.message(map, UNSUB);
    await Bun.sleep(2_050);
    hub.ingest("e", pos(2));
    expect(map.positions()).toHaveLength(1);
  });

  it("keeps an old client (no topics) on positions, as before", async () => {
    const { hub, ws, watches } = setup();
    const old = socket("/live");
    ws.open(old);
    hub.ingest("e", pos(1));
    expect(old.positions()).toHaveLength(1);
    await flush();
    expect(watches).toEqual([true]);
  });

  it("hands a fresh sample to a socket that subscribes late", () => {
    const { hub, ws } = setup();
    const a = socket("/live?topics=positions");
    ws.open(a);
    hub.ingest("e", pos(7));
    const b = socket("/live?topics=");
    ws.open(b);
    expect(b.positions()).toHaveLength(0);
    ws.message(b, SUB);
    expect(b.positions()).toMatchObject([{ t: 7 }]);
  });

  it("tells the agent when the first watcher comes and the last one goes, and renews meanwhile", async () => {
    const { ws, watches } = setup(30);
    const a = socket("/live?topics=");
    const b = socket("/live?topics=");
    ws.open(a);
    ws.open(b);
    expect(watches).toEqual([]);
    ws.message(a, SUB);
    ws.message(b, SUB);
    ws.message(b, SUB); // twice: still one watcher
    await flush();
    expect(watches).toEqual([true]);
    await Bun.sleep(80);
    expect(watches.filter((w) => w).length).toBeGreaterThan(1);
    ws.message(a, UNSUB);
    await flush();
    expect(watches.at(-1)).toBe(true);
    ws.close(b);
    await flush();
    expect(watches.at(-1)).toBe(false);
    const n = watches.length;
    await Bun.sleep(80);
    expect(watches).toHaveLength(n);
  });

  it("never lets a slow lease end overtake the next start (a reload of the only map)", async () => {
    const done: boolean[] = [];
    const agent = watchAgent([]);
    agent.watchPositions = async (on) => {
      if (!on) await Bun.sleep(30);
      done.push(on);
    };
    hub = new Hub(agent, new HistoryStore(":memory:"));
    const ws = liveSocket(hub);
    const before = socket("/live?topics=positions");
    ws.open(before);
    ws.close(before);
    ws.open(socket("/live?topics=positions"));
    await Bun.sleep(80);
    expect(done).toEqual([true, false, true]);
  });

  it("hands an idle player's position to a late watcher however old it is", () => {
    let now = 1_000_000;
    hub = new Hub(watchAgent([]), new HistoryStore(":memory:"), { clock: () => now });
    const ws = liveSocket(hub);
    ws.open(socket("/live?topics=positions"));
    hub.ingest("e", pos(3));
    // The agent sends only changes, so nothing new comes while Ragnar stands still.
    now += 60_000;
    const late = socket("/live?topics=positions");
    ws.open(late);
    expect(late.positions()).toMatchObject([{ t: 3 }]);
  });

  it("does not take a lease once stopped", async () => {
    const { hub, ws, watches } = setup();
    hub.stop();
    ws.open(socket("/live?topics=positions"));
    await flush();
    expect(watches).toEqual([]);
  });

  it("ignores junk from a socket", () => {
    const { hub, ws } = setup();
    const s = socket("/live?topics=");
    ws.open(s);
    for (const m of ["nope", "{}", "null", JSON.stringify({ type: "subscribe", topic: "logs" }), JSON.stringify({ type: "subscribe" }), SUB.padEnd(10_000)]) {
      expect(() => ws.message(s, m)).not.toThrow();
    }
    hub.ingest("e", pos(1));
    expect(s.positions()).toHaveLength(0);
  });
});

describe("live history deltas per socket", () => {
  it("sends rankings deltas only to sockets opened with history=1, whatever their topics", async () => {
    const hub = new Hub(watchAgent([]), new HistoryStore(":memory:"), { historyDeltaMs: 10 });
    (hub as unknown as { state: ReturnType<typeof emptyAgentState> }).state = emptyAgentState(new Date("2026-10-09T17:00:00Z"));
    const ws = liveSocket(hub);
    const current = socket("/live?topics=&history=1");
    const old = socket("/live");
    ws.open(current);
    ws.open(old);
    expect(current.data).toMatchObject({ positions: false, history: true });
    expect(old.data).toMatchObject({ positions: true, history: false });
    hub.ingest("A", { seq: 1, ts: "2026-10-09T17:30:00Z", type: "player_join", data: { name: "Ragnar" } });
    await Bun.sleep(30);
    expect(current.sent.filter((m) => m.type === "history")).toHaveLength(1);
    expect(old.sent.filter((m) => m.type === "history")).toHaveLength(0);
    hub.stop();
  });
});

describe("HttpAgent positions lease", () => {
  it("streams with the lease and maps watch calls to /positions/watch", async () => {
    const { HttpAgent } = await import("../src/agent");
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method ?? "GET"} ${url.replace(/holder=[0-9a-f-]{36}/, "holder=H")} ${(init.headers as Record<string, string>)["X-Agent-Token"]}`);
      return url.includes("/events") ? new Response("", { status: 200 }) : new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const a = new HttpAgent("http://agent:8080", "tok", fetchImpl);
    await a.watchPositions(true);
    await a.watchPositions(false);
    await a.stream(4, () => {}, new AbortController().signal);
    expect(seen).toEqual([
      "POST http://agent:8080/positions/watch?holder=H tok",
      "DELETE http://agent:8080/positions/watch?holder=H tok",
      "GET http://agent:8080/events?since=4&positions=lease tok",
    ]);
  });
});
