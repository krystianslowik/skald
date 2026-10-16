import { afterAll, describe, expect, it } from "bun:test";
import { createSession, SESSION_COOKIE, upgradeLive } from "../src/auth";

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
