import { afterEach, describe, expect, it, vi } from "vitest";
import { unlockAdmin } from "./admin";
import { login, logout } from "./api";

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));

describe("sign-in refused by the origin check", () => {
  it("is told apart from a wrong password", async () => {
    answer(403, { ok: false, error: "cross_origin" });
    expect(await login("ognisko")).toEqual({ ok: false, refused: true });
    expect(await unlockAdmin("jarl")).toEqual({ ok: false, refused: true });
    answer(401, { ok: false, error: "invalid" });
    expect(await login("nope")).toEqual({ ok: false });
    answer(403, { ok: false, error: "something_else" });
    expect(await unlockAdmin("nope")).toEqual({ ok: false });
  });
});

describe("log out", () => {
  it("counts only when the server ended the session", async () => {
    answer(200, { ok: true });
    expect(await logout()).toBe("ok");
    answer(403, { ok: false, error: "cross_origin" });
    expect(await logout()).toBe("refused");
    answer(403, { ok: false, error: "something_else" });
    expect(await logout()).toBe("failed");
    // A proxy's sign-in page reached through a redirect: a 200, but not skald-web's answer.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Sign in</html>", { status: 200 })));
    expect(await logout()).toBe("failed");
    // A proxy's error page while skald-web is down.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<h1>Bad Gateway</h1>", { status: 502 })));
    expect(await logout()).toBe("offline");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await logout()).toBe("offline");
  });
});

describe("log out and the kept terrain", () => {
  it("drops the terrain tiles kept on this device, and only those, once the session ended", async () => {
    const names = new Set(["skald-shell-abc", "skald-terrain-b1"]);
    vi.stubGlobal("caches", { keys: async () => [...names], delete: async (n: string) => names.delete(n) });
    answer(403, { ok: false, error: "cross_origin" });
    expect(await logout()).toBe("refused");
    expect([...names]).toEqual(["skald-shell-abc", "skald-terrain-b1"]);
    answer(200, { ok: true });
    expect(await logout()).toBe("ok");
    expect([...names]).toEqual(["skald-shell-abc"]);
  });
});
