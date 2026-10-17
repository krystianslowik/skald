import { afterEach, describe, expect, it, vi } from "vitest";
import { unlockAdmin } from "./admin";
import { login } from "./api";

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
