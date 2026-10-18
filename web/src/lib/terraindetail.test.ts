import { describe, expect, it } from "vitest";
import { TILE_FS } from "./mapgl";
import { DETAIL_FROM, DETAIL_TO, detailAt, NOISE_SIZE, noiseTexture } from "./terraindetail";

describe("detailAt", () => {
  it("is off at mid zoom, full close up, even in log zoom between", () => {
    expect(detailAt(0.5)).toBe(0);
    expect(detailAt(DETAIL_FROM)).toBe(0);
    expect(detailAt(6)).toBeCloseTo(0.5, 6);
    expect(detailAt(DETAIL_TO)).toBe(1);
    expect(detailAt(24)).toBe(1);
  });

  it("is off for a broken scale", () => {
    expect(detailAt(0)).toBe(0);
    expect(detailAt(Number.NaN)).toBe(0);
  });
});

describe("noiseTexture", () => {
  const N = NOISE_SIZE;
  const tex = noiseTexture();
  const at = (x: number, y: number) => tex[y * N + x]!;

  it("is one byte a texel, built once, and spans the byte range", () => {
    expect(tex.length).toBe(N * N);
    expect(noiseTexture()).toBe(tex);
    expect(Math.min(...tex)).toBe(0);
    expect(Math.max(...tex)).toBe(255);
  });

  it("repeats without a seam: across the wrap it changes no more than between neighbours inside", () => {
    let inside = 0;
    let seam = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 1; x < N; x++) inside = Math.max(inside, Math.abs(at(x, y) - at(x - 1, y)), Math.abs(at(y, x) - at(y, x - 1)));
      seam = Math.max(seam, Math.abs(at(0, y) - at(N - 1, y)), Math.abs(at(y, 0) - at(y, N - 1)));
    }
    expect(inside).toBeGreaterThan(0);
    expect(seam).toBeLessThanOrEqual(inside);
  });
});

describe("TILE_FS", () => {
  it("keeps every per-pixel array at 16 entries or fewer (more spills registers on phone GPUs)", () => {
    const sizes = [...TILE_FS.matchAll(/\b(?:float|uint|int|vec\d|uvec\d)\s+\w+\[(\d+)\]/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(16);
  });
});
