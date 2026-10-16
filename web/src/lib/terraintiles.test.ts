import { describe, expect, it, vi } from "vitest";
import { mockTerrainTile, packHeights } from "@server/mocktiles";
import { ByteLRU, levelFor, paintFactor, TileScheduler, tileMpp, tilesIn } from "./terraintiles";
import { decodeTile, paintTile, paletteOf, TUNED } from "./terrainpaint";

const R = 10500;

describe("levels", () => {
  it("picks the coarsest level that is sharp enough, up to the top", () => {
    expect(tileMpp(3, R)).toBeCloseTo(21000 / 2048);
    // Whole world on a phone: level 0 or 1.
    expect(levelFor(0.02, 2, 7, R)).toBeLessThanOrEqual(2);
    // Each step of zoom by 2 is one level, until the top.
    const a = levelFor(0.1, 2, 7, R);
    expect(levelFor(0.2, 2, 7, R)).toBe(a + 1);
    expect(levelFor(24, 3, 7, R)).toBe(7);
    // The pixel ratio is capped at 2, like the cached base.
    expect(levelFor(0.2, 3, 7, R)).toBe(levelFor(0.2, 2, 7, R));
    // A grid-only pyramid stops at its own top.
    expect(levelFor(24, 2, 3, R)).toBe(3);
    expect(paintFactor(7, 7, 8)).toBe(4);
    expect(paintFactor(7, 7, 2)).toBe(2);
    expect(paintFactor(5, 7, 24)).toBe(2);
  });

  it("lists the tiles over a box inside the world, nearest the centre first", () => {
    const all = tilesIn({ x0: -R, z0: -R, x1: R, z1: R }, 3, R);
    // 64 tiles, but the corner ones lie wholly outside the disc.
    expect(all).toHaveLength(60);
    expect(all.find((t) => t.x === 0 && t.y === 0)).toBeUndefined();
    expect(all.find((t) => t.x === 0 && t.y === 3)).toBeDefined();
    const span = tileMpp(5, R) * 256;
    const near = tilesIn({ x0: -10, z0: -10, x1: 10 + span, z1: 10 }, 5, R);
    expect(near[0]).toEqual({ z: 5, x: 16, y: 15 });
    expect(near.map((t) => `${t.x},${t.y}`)).toEqual(expect.arrayContaining(["15,15", "16,15", "17,15", "15,16", "16,16", "17,16"]));
    // Out of range boxes clamp.
    expect(tilesIn({ x0: 20000, z0: 20000, x1: 30000, z1: 30000 }, 3, R)).toEqual([]);
  });
});

describe("ByteLRU", () => {
  it("evicts the least recently used past its budget and closes it", () => {
    const evicted: string[] = [];
    const lru = new ByteLRU<string>(100, (v) => evicted.push(v));
    lru.set("a", "A", 40);
    lru.set("b", "B", 40);
    expect(lru.get("a")).toBe("A");
    lru.set("c", "C", 40);
    expect(evicted).toEqual(["B"]);
    expect(lru.bytes).toBe(80);
    expect(lru.peek("b")).toBeUndefined();
  });

  it("spares what the view draws, even over budget", () => {
    const lru = new ByteLRU<string>(50, () => {});
    lru.set("a", "A", 40);
    lru.set("b", "B", 40, new Set(["a"]));
    expect(lru.size).toBe(2);
    lru.set("c", "C", 40, new Set(["c"]));
    expect(lru.peek("a")).toBeUndefined();
    expect(lru.peek("b")).toBeUndefined();
    expect(lru.size).toBe(1);
    lru.clear();
    expect(lru.bytes).toBe(0);
  });
});

describe("TileScheduler", () => {
  it("runs at most four at a time, in the order asked", () => {
    const started: string[] = [];
    const s = new TileScheduler(4, (k) => {
      started.push(k);
      return () => {};
    });
    s.update(["a", "b", "c", "d", "e", "f"]);
    expect(started).toEqual(["a", "b", "c", "d"]);
    s.finish("b");
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    expect([...s.inflight].sort()).toEqual(["a", "c", "d", "e"]);
  });

  it("cancels what left the view and starts the new view's tiles first", () => {
    const cancelled: string[] = [];
    const started: string[] = [];
    const s = new TileScheduler(2, (k) => {
      started.push(k);
      return () => cancelled.push(k);
    });
    s.update(["a", "b", "c"]);
    s.update(["x", "b", "y"]);
    expect(cancelled).toEqual(["a"]);
    expect(started).toEqual(["a", "b", "x"]);
    // Still wanted, still running: not restarted.
    s.update(["x", "b"]);
    expect(started).toEqual(["a", "b", "x"]);
    s.update([]);
    expect(cancelled.sort()).toEqual(["a", "b", "x"]);
    expect(s.inflight.size).toBe(0);
  });

  it("does not restart a finished tile unless asked again", () => {
    const start = vi.fn(() => () => {});
    const s = new TileScheduler(4, start);
    s.update(["a"]);
    s.finish("a");
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("terrain paint", () => {
  const tile = (z: number, x: number, y: number) => decodeTile(mockTerrainTile(z, x, y)!.buffer as ArrayBuffer);
  const opt = { factor: 2, palette: paletteOf(null), waterLevel: 30, radius: R };

  it("decodes the bridge's tile format", () => {
    const t = tile(4, 7, 7);
    expect(t.n).toBe(260);
    expect(t.step).toBeCloseTo(tileMpp(4, R), 3);
    expect(t.forest).not.toBeNull();
    expect(() => decodeTile(new ArrayBuffer(10))).toThrow();
  });

  it("undoes the agent's height packing", () => {
    const raw = mockTerrainTile(6, 20, 30)!;
    const plain = decodeTile(raw.slice().buffer as ArrayBuffer);
    const packed = decodeTile(packHeights(raw).buffer as ArrayBuffer);
    expect(packed.heights).toEqual(plain.heights);
    expect([...packed.biomes]).toEqual([...plain.biomes]);
  });

  it("neighbours meet without a seam", () => {
    // Across the seam, pixels differ no more than neighbouring columns inside a tile do.
    const S = 512;
    const colDiff = (p: Uint8ClampedArray, q: Uint8ClampedArray, pc: number, qc: number) => {
      let sum = 0;
      for (let r = 0; r < S; r++) for (let c = 0; c < 3; c++) sum += Math.abs(p[(r * S + pc) * 4 + c]! - q[(r * S + qc) * 4 + c]!);
      return sum / (S * 3);
    };
    for (const [ax, ay, bx, by] of [
      [10, 15, 11, 15],
      [20, 18, 21, 18],
    ] as const) {
      const a = paintTile(tile(5, ax, ay), opt);
      const b = paintTile(tile(5, bx, by), opt);
      const inside = colDiff(a, a, S - 2, S - 1);
      expect(colDiff(a, b, S - 1, 0)).toBeLessThanOrEqual(inside * 1.5 + 0.5);
    }
  });

  it("uses the game's colours when the bridge read them, tuned ones otherwise", () => {
    expect(paletteOf(null).biome[1]).toEqual(TUNED.Meadows);
    expect(paletteOf({ source: "none" }).biome[2]).toEqual(TUNED.Swamp);
    const game = paletteOf({ source: "prefab", biomes: { Meadows: "#102030" } });
    expect(game.biome[1]).toEqual([16, 32, 48]);
    // A colour the game did not give stays tuned.
    expect(game.biome[3]).toEqual(TUNED.Mountain);
  });

  it("is transparent outside the world and opaque inside", () => {
    // Tile 0/0/0 covers the whole world: its corner pixel is outside the disc.
    const px = paintTile(tile(0, 0, 0), { ...opt, factor: 1 });
    expect(px[3]).toBe(0);
    expect(px[(128 * 256 + 128) * 4 + 3]).toBe(255);
  });
});
