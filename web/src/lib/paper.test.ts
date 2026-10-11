import { describe, expect, it } from "vitest";
import { cloudPixels, paperPixels } from "./paper";

describe("paper textures", () => {
  it("makes the same seamless tiles every time", () => {
    const a = cloudPixels(64);
    expect(a).toEqual(cloudPixels(64));
    expect(a.length).toBe(64 * 64 * 4);
    // Seamless: the last column runs on into the first as smoothly as any two neighbours.
    const at = (x: number, y: number) => a[(y * 64 + x) * 4]!;
    let wrap = 0;
    let inner = 0;
    for (let y = 0; y < 64; y++) {
      wrap = Math.max(wrap, Math.abs(at(63, y) - at(0, y)));
      inner = Math.max(inner, Math.abs(at(31, y) - at(32, y)));
    }
    expect(wrap).toBeLessThanOrEqual(inner + 2);
    const p = paperPixels(32);
    for (let i = 0; i < p.length; i += 4) expect([p[i], p[i + 1], p[i + 2]]).toEqual([92, 64, 32]);
  });
});
