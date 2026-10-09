import { describe, expect, it } from "bun:test";
import { hashPassword } from "../src/hash";

describe("hash-password", () => {
  it("strips one trailing newline and produces a verifiable argon2id hash", async () => {
    const h = await hashPassword("correct horse\n");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await Bun.password.verify("correct horse", h)).toBe(true);
    expect(await Bun.password.verify("correct horse\n", h)).toBe(false);
  });

  it("keeps inner and leading whitespace", async () => {
    const h = await hashPassword(" two  words \r\n");
    expect(await Bun.password.verify(" two  words ", h)).toBe(true);
  });

  it("refuses an empty password", async () => {
    expect(hashPassword("\n")).rejects.toThrow("empty password");
  });
});
