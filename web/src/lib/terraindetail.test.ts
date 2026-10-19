import { describe, expect, it } from "vitest";
import { TILE_FS, TILE_FS_LITE } from "./mapgl";
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
  const at = (x: number, y: number, c: number) => tex[4 * (y * N + x) + c]!;
  const channel = (c: number) => Array.from({ length: N * N }, (_, i) => tex[4 * i + c]!);

  it("is four bytes a texel, built once, its smooth and fine noise spanning the byte range", () => {
    expect(tex.length).toBe(N * N * 4);
    expect(noiseTexture()).toBe(tex);
    for (const c of [0, 1]) {
      expect(Math.min(...channel(c))).toBe(0);
      expect(Math.max(...channel(c))).toBe(255);
    }
  });

  it("has cell distances: near 0 at the cell points (B) and along the cell walls (A)", () => {
    expect(Math.min(...channel(2))).toBeLessThan(8);
    expect(Math.max(...channel(2))).toBeGreaterThan(100);
    expect(Math.min(...channel(3))).toBeLessThan(8);
  });

  it("repeats without a seam in every channel: across the wrap it changes no more than between neighbours inside", () => {
    for (const c of [0, 1, 2, 3]) {
      let inside = 0;
      let seam = 0;
      for (let y = 0; y < N; y++) {
        for (let x = 1; x < N; x++) inside = Math.max(inside, Math.abs(at(x, y, c) - at(x - 1, y, c)), Math.abs(at(y, x, c) - at(y, x - 1, c)));
        seam = Math.max(seam, Math.abs(at(0, y, c) - at(N - 1, y, c)), Math.abs(at(y, 0, c) - at(y, N - 1, c)));
      }
      expect(inside).toBeGreaterThan(0);
      expect(seam).toBeLessThanOrEqual(inside);
    }
  });
});

describe("TILE_FS", () => {
  it("keeps every per-pixel array at 16 entries or fewer (more spills registers on phone GPUs)", () => {
    for (const src of [TILE_FS, TILE_FS_LITE]) {
      const sizes = [...src.matchAll(/\b(?:float|uint|int|vec\d|uvec\d)\s+\w+\[(\d+)\]/g)].map((m) => Number(m[1]));
      expect(sizes.length).toBeGreaterThan(0);
      for (const n of sizes) expect(n).toBeLessThanOrEqual(16);
    }
  });

  it("builds the close-zoom detail into the full shader only: performance mode's skips it at compile time", () => {
    expect(TILE_FS).toContain("#define FULL 1");
    expect(TILE_FS_LITE).toContain("#define FULL 0");
    // The same source otherwise: performance mode is the full shader with the detail compiled out.
    expect(TILE_FS_LITE.replace("#define FULL 0", "#define FULL 1")).toBe(TILE_FS);
    for (const part of ["uContours", "strata", "crack", "lkw"]) expect(TILE_FS).toContain(part);
  });
});
