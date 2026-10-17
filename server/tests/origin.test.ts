import { afterAll, describe, expect, it } from "bun:test";
import type { AgentSource } from "../src/agent";
import { createApp, panelOriginPolicy } from "../src/app";
import { createSession, SESSION_COOKIE, upgradeLive } from "../src/auth";
import { loadConfig } from "../src/config";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { silentLog } from "../src/log";
import { checkOrigin } from "../src/origin";
import { emptyAgentState } from "../src/types";

const SECRET = "secret";
const HASH = await Bun.password.hash("ognisko");
const COOKIE = `${SESSION_COOKIE}=${createSession(SECRET)}`;

const notFound = async () => new Response(null, { status: 404 });
const agent: AgentSource = {
  getState: async () => emptyAgentState(),
  getLogs: async () => [],
  action: async () => ({ status: 200, body: { ok: true, message: "done" } }),
  backup: notFound,
  stream: async () => {},
  map: async () => ({ status: 404, etag: null, body: null }),
  pieces: notFound,
  nature: notFound,
  asset: notFound,
  bridge: async () => ({ status: 404, body: { ok: false, message: "not found" } }),
  tools: async () => ({ status: 404, body: { ok: false, message: "not found" } }),
  settings: async () => ({ status: 200, body: { ok: true } }),
};

/** The panel behind a real listener, so the Host header reaches the app as it does in production. */
function serve(opts: { publicOrigins?: string[]; trustedIpHeader?: string } = {}) {
  const hub = new Hub(agent, new HistoryStore(":memory:"));
  Object.defineProperty(hub, "online", { get: () => true });
  const app = createApp({ sessionSecret: SECRET, passwordHash: HASH, secureCookie: false, agent, hub, metrics: async () => null, log: silentLog, ...opts });
  const policy = panelOriginPolicy(opts);
  const server = Bun.serve<object>({
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/live") return upgradeLive(req, SECRET, () => srv.upgrade(req, { data: {} }), { origin: policy });
      return app.fetch(req, { server: srv });
    },
    websocket: { message() {} },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    fetch(base + path, { method, headers: { Cookie: COOKIE, "Content-Type": "application/json", ...headers }, body: method === "GET" ? undefined : "{}" });
  return { base, host: `127.0.0.1:${server.port}`, call };
}
const servers: { stop(force?: boolean): unknown }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const CHANGES = [
  ["POST", "/api/action/backup"],
  ["PUT", "/api/settings"],
  ["DELETE", "/api/settings/apply"],
  ["POST", "/api/logout"],
] as const;

describe("origin check on requests that change something", () => {
  it("refuses another origin's POST, PUT and DELETE, also one on the same site", async () => {
    const p = serve();
    for (const origin of ["http://127.0.0.1:1", "https://evil.example", "null"]) {
      for (const [method, path] of CHANGES) {
        const res = await p.call(method, path, { Origin: origin });
        expect([origin, method, path, res.status]).toEqual([origin, method, path, 403]);
        expect(((await res.json()) as { error: string }).error).toBe("cross_origin");
      }
    }
    // Login too: a page elsewhere must not sign a browser in.
    expect((await p.call("POST", "/api/login", { Origin: "http://127.0.0.1:1" })).status).toBe(403);
  });

  it("accepts the panel's own page", async () => {
    const p = serve();
    for (const [method, path] of CHANGES) {
      const res = await p.call(method, path, { Origin: p.base, "Sec-Fetch-Site": "same-origin" });
      expect([method, path, res.status]).toEqual([method, path, 200]);
    }
    // An older browser without Sec-Fetch-Site: Origin alone.
    expect((await p.call("POST", "/api/action/backup", { Origin: p.base })).status).toBe(200);
  });

  it("accepts clients that are no browser (no Origin, no Sec-Fetch-Site)", async () => {
    const p = serve();
    for (const [method, path] of CHANGES) expect((await p.call(method, path)).status).toBe(200);
  });

  it("refuses by Sec-Fetch-Site when there is no Origin", async () => {
    const p = serve();
    for (const site of ["same-site", "cross-site"]) expect((await p.call("POST", "/api/action/backup", { "Sec-Fetch-Site": site })).status).toBe(403);
    // Sec-Fetch-Site wins over a matching Origin: a same-site page is refused.
    expect((await p.call("POST", "/api/action/backup", { Origin: p.base, "Sec-Fetch-Site": "same-site" })).status).toBe(403);
    expect((await p.call("POST", "/api/action/backup", { "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    expect((await p.call("POST", "/api/action/backup", { "Sec-Fetch-Site": "none" })).status).toBe(200);
  });

  it("leaves reads alone", async () => {
    const p = serve();
    const res = await fetch(`${p.base}/api/state`, { headers: { Cookie: COOKIE, Origin: "https://evil.example" } });
    expect(res.status).toBe(200);
  });

  it("checks against the Host a TLS-terminating proxy passes on, whatever the scheme", async () => {
    const p = serve();
    const proxied = { Host: "panel.example", "X-Forwarded-Proto": "https" };
    expect((await p.call("POST", "/api/action/backup", { ...proxied, Origin: "https://panel.example" })).status).toBe(200);
    expect((await p.call("POST", "/api/action/backup", { ...proxied, Origin: "http://panel.example" })).status).toBe(200);
    expect((await p.call("POST", "/api/action/backup", { ...proxied, Origin: "https://panel.example:8443" })).status).toBe(403);
    expect((await p.call("POST", "/api/action/backup", { ...proxied, Origin: "https://other.panel.example" })).status).toBe(403);
    expect((await p.call("POST", "/api/action/backup", { Host: "panel.example:443", Origin: "https://panel.example" })).status).toBe(200);
  });

  it("takes X-Forwarded-Host only behind a configured proxy", async () => {
    const rewritten = { Host: "skald-web:8080", "X-Forwarded-Host": "panel.example", Origin: "https://panel.example" };
    expect((await serve().call("POST", "/api/action/backup", rewritten)).status).toBe(403);
    expect((await serve({ trustedIpHeader: "X-Forwarded-For" }).call("POST", "/api/action/backup", rewritten)).status).toBe(200);
  });

  it("honours PUBLIC_ORIGIN exactly, scheme included", async () => {
    const p = serve({ publicOrigins: ["https://panel.example"] });
    const behind = { Host: "skald-web:8080" };
    expect((await p.call("POST", "/api/action/backup", { ...behind, Origin: "https://panel.example" })).status).toBe(200);
    expect((await p.call("POST", "/api/action/backup", { ...behind, Origin: "http://panel.example" })).status).toBe(403);
    // The request's own host no longer counts once PUBLIC_ORIGIN is set.
    expect((await p.call("POST", "/api/action/backup", { Origin: p.base })).status).toBe(403);
  });

  it("trusts the browser's Sec-Fetch-Site: same-origin when a proxy rewrote Host", async () => {
    const p = serve();
    const res = await p.call("POST", "/api/action/backup", { Host: "skald-web:8080", Origin: "https://panel.example", "Sec-Fetch-Site": "same-origin" });
    expect(res.status).toBe(200);
  });
});

describe("/live origin check", () => {
  it("refuses a socket opened by another origin's page", async () => {
    const p = serve();
    const res = await fetch(`${p.base}/live`, { headers: { Upgrade: "websocket", Connection: "Upgrade", Cookie: COOKIE, Origin: "http://127.0.0.1:1" } });
    expect(res.status).toBe(403);
  });

  it("opens for the panel's page", async () => {
    const p = serve();
    const sock = new WebSocket(`ws://${p.host}/live`, { headers: { Cookie: COOKIE, Origin: p.base } } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      sock.onopen = () => resolve();
      sock.onerror = () => reject(new Error("socket error"));
    });
    sock.close();
  });
});

describe("checkOrigin", () => {
  const policy = { publicOrigins: [], trustForwardedHost: false };
  const at = (headers: Record<string, string>) => new Request("http://panel.example/api/x", { method: "POST", headers });
  it("says which origin it expected", () => {
    expect(checkOrigin(at({ Origin: "https://evil.example" }), policy)).toEqual({ ok: false, origin: "https://evil.example", expected: "panel.example" });
    expect(checkOrigin(at({ Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" }), policy)).toEqual({
      ok: true,
      mismatch: { origin: "https://evil.example", expected: "panel.example" },
    });
  });
});

describe("PUBLIC_ORIGIN", () => {
  const base = { AGENT_URL: "http://agent:8080", AGENT_TOKEN: "t", PANEL_PASSWORD_HASH: "h", SESSION_SECRET: "s" };
  it("is empty by default and normalised when set", () => {
    expect(loadConfig(base).publicOrigins).toEqual([]);
    expect(loadConfig({ ...base, PUBLIC_ORIGIN: "https://Panel.Example/" }).publicOrigins).toEqual(["https://panel.example"]);
    expect(loadConfig({ ...base, PUBLIC_ORIGIN: "https://panel.example:443, http://192.0.2.10:8080" }).publicOrigins).toEqual(["https://panel.example", "http://192.0.2.10:8080"]);
  });
  it("refuses anything that is not an origin", () => {
    for (const bad of ["panel.example", "https://panel.example/skald", "ftp://panel.example", "https://panel.example?x=1", "https://user@panel.example"]) {
      expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: bad })).toThrow("PUBLIC_ORIGIN");
    }
  });
});
