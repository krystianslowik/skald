import { afterEach, describe, expect, it, vi } from "vitest";
import { mockTerrainTile, packHeights } from "@server/mocktiles";
import { ByteLRU, levelFor, loadLimit, LOADS_AT_REST, LOADS_MOVING, paintFactor, pinnedTiles, planView, TerrainTiles, tileBox, tileKey, TileScheduler, tileMpp, tilesIn, type Box, type TileRef, type TilesDoc } from "./terraintiles";
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

  it("paints a sample to about one pixel below 1 px/m", () => {
    // 0.3 px/m on a phone (base canvas at 2x): level 6, painted 1:1, a sample about 0.8 px.
    const z = levelFor(0.3, 2, 7, R);
    expect(z).toBe(6);
    expect(paintFactor(z, 7, 0.3)).toBe(1);
    expect(tileMpp(z, R) * 0.3 * 2).toBeGreaterThan(0.7);
    expect(tileMpp(z, R) * 0.3 * 2).toBeLessThan(1.42);
    expect(paintFactor(7, 7, 0.6)).toBe(1);
    expect(paintFactor(7, 7, 1)).toBe(2);
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

/** A phone's view (390 x 844 CSS px) at `scale`, and the 1.5x box a cached base draws. */
function phone(scale: number, cx = -3609, cz = 328): { view: Box; box: Box } {
  const hw = 390 / 2 / scale;
  const hh = 844 / 2 / scale;
  return { view: { x0: cx - hw, z0: cz - hh, x1: cx + hw, z1: cz + hh }, box: { x0: cx - hw * 1.5, z0: cz - hh * 1.5, x1: cx + hw * 1.5, z1: cz + hh * 1.5 } };
}
const keys = (ts: readonly TileRef[]) => ts.map(tileKey);
const children = (t: TileRef): TileRef[] => [0, 1, 2, 3].map((i) => ({ z: t.z + 1, x: 2 * t.x + (i & 1), y: 2 * t.y + (i >> 1) }));

describe("planView", () => {
  const plan = (scale: number, loaded: Iterable<string>) => {
    const have = new Set(loaded);
    return planView({ ...phone(scale), scale, dpr: 2, maxLevel: 7, radius: R, has: (t) => have.has(tileKey(t)) });
  };

  it("keeps levels 0-3 of the whole disc, coarsest first", () => {
    const p = pinnedTiles(7, R);
    expect(p[0]).toEqual({ z: 0, x: 0, y: 0 });
    expect(p.map((t) => t.z)).toEqual([...p.map((t) => t.z)].sort((a, b) => a - b));
    expect(p.filter((t) => t.z === 3)).toHaveLength(60);
    expect(p.every((t) => t.z <= 3)).toBe(true);
    // A grid-only pyramid that stops at level 2 keeps what it has.
    expect(Math.max(...pinnedTiles(2, R).map((t) => t.z))).toBe(2);
  });

  it("asks for level 0 first, then the visible tiles, then a ring and the rest of levels 0-3 at low priority", () => {
    const p = plan(0.3, []);
    expect(p.z).toBe(6);
    expect(tileKey(p.want[0]!)).toBe("0/0/0");
    const { view } = phone(0.3);
    const visible = keys(tilesIn(view, 6, R));
    expect(keys(p.want.slice(1, p.low))).toEqual(visible);
    const low = p.want.slice(p.low);
    // The ring: level 6 tiles next to the view, none of them visible.
    const ring = low.filter((t) => t.z === 6);
    expect(ring.length).toBeGreaterThan(0);
    expect(ring.every((t) => !visible.includes(tileKey(t)))).toBe(true);
    const span = tileMpp(6, R) * 256;
    for (const t of ring) {
      const b = tileBox(t, R);
      expect(b.x1 > view.x0 - span && b.x0 < view.x1 + span && b.z1 > view.z0 - span && b.z0 < view.z1 + span).toBe(true);
    }
    // The rest of levels 0-3, once each.
    expect(low.filter((t) => t.z <= 3)).toHaveLength(pinnedTiles(7, R).length - 1);
    expect(new Set(keys(p.want)).size).toBe(p.want.length);
    // Nothing loaded: every slot is blank.
    expect(p.slots.every((s) => s.blank)).toBe(true);
  });

  it("needs a quarter of the old working set at 0.3 px/m", () => {
    // Before: 84 tiles of 1 MiB over the 1.5x base. Now: the visible tiles plus a ring, 256 KiB each.
    const p = plan(0.3, ["0/0/0"]);
    const ringAndVisible = p.want.filter((t) => t.z === p.z).length;
    expect(p.low).toBeLessThanOrEqual(45);
    expect((ringAndVisible * 256 * 256 * 4) / 2 ** 20).toBeLessThan(21);
  });

  it("never leaves a slot blank once level 0 is in, and asks only for what is missing", () => {
    const p = plan(0.3, ["0/0/0"]);
    expect(p.slots.every((s) => !s.blank && s.ancestor && tileKey(s.ancestor) === "0/0/0")).toBe(true);
    expect(keys(p.want)).not.toContain("0/0/0");
    // The nearest loaded ancestor wins.
    const t = p.slots[0]!.tile;
    const parent = { z: t.z - 1, x: t.x >> 1, y: t.y >> 1 };
    const q = plan(0.3, ["0/0/0", tileKey(parent), tileKey(t)]);
    expect(q.slots[0]!.own).toBe(true);
    const sib = q.slots.find((s) => !s.own && s.tile.x >> 1 === parent.x && s.tile.y >> 1 === parent.y)!;
    expect(sib.ancestor).toEqual(parent);
  });

  it("draws loaded children (two levels down) over the ancestor when zooming out", () => {
    const t = plan(0.15, ["0/0/0"]).slots[0]!.tile;
    expect(t.z).toBe(5);
    const [c0, c1, c2, c3] = children(t) as [TileRef, TileRef, TileRef, TileRef];
    // All four children: they cover the slot, no ancestor needed.
    let s = plan(0.15, ["0/0/0", ...keys([c0, c1, c2, c3])]).slots[0]!;
    expect(s.own).toBe(false);
    expect(keys(s.descendants).sort()).toEqual(keys([c0, c1, c2, c3]).sort());
    expect(s.ancestor).toBeNull();
    expect(s.blank).toBe(false);
    // Three children and the fourth's own four children cover it too.
    s = plan(0.15, ["0/0/0", ...keys([c0, c1, c2, ...children(c3)])]).slots[0]!;
    expect(s.descendants).toHaveLength(7);
    expect(s.ancestor).toBeNull();
    // Part of it: the ancestor under, the children over.
    s = plan(0.15, ["0/0/0", tileKey(c0), tileKey(children(c1)[0]!)]).slots[0]!;
    expect(keys(s.descendants)).toEqual([tileKey(c0), tileKey(children(c1)[0]!)]);
    expect(tileKey(s.ancestor!)).toBe("0/0/0");
    // Without level 0, a part covered by children is still blank.
    expect(plan(0.15, [tileKey(c0)]).slots[0]!.blank).toBe(true);
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

  it("runs one low-priority key at a time, after the others", () => {
    const started: [string, boolean][] = [];
    const s = new TileScheduler(4, (k, low) => {
      started.push([k, low]);
      return () => {};
    });
    s.update(["a", "b", "x", "y", "z"], 2);
    expect(started).toEqual([
      ["a", false],
      ["b", false],
      ["x", true],
    ]);
    s.finish("x");
    expect(started.at(-1)).toEqual(["y", true]);
    // A key that matters arrives: it takes a free slot at once, ahead of the next low one.
    s.update(["c", "y", "z"], 1);
    expect(started.at(-1)).toEqual(["c", false]);
    expect([...s.inflight].sort()).toEqual(["c", "y"]);
  });

  it("starts no more than it is allowed until the next update", () => {
    const started: string[] = [];
    const s = new TileScheduler(6, (k) => {
      started.push(k);
      return () => {};
    });
    s.update(["a", "b", "c", "d"], 4, 2);
    expect(started).toEqual(["a", "b"]);
    // A finished load frees a slot, not the allowance.
    s.finish("a");
    expect(started).toEqual(["a", "b"]);
    s.update(["b", "c", "d"], 3, 0);
    expect(started).toEqual(["a", "b"]);
    s.update(["b", "c", "d"]);
    expect(started).toEqual(["a", "b", "c", "d"]);
  });

  it("holds new starts under a lowered limit without cancelling what runs, and fills up when it rises", () => {
    const started: string[] = [];
    const cancelled: string[] = [];
    const s = new TileScheduler(16, (k) => {
      started.push(k);
      return () => cancelled.push(k);
    });
    const keys = Array.from({ length: 24 }, (_, i) => `k${i}`);
    s.update(keys);
    expect(started).toHaveLength(16);
    s.update(keys, keys.length, Infinity, 8);
    expect(cancelled).toEqual([]);
    expect(s.inflight.size).toBe(16);
    for (let i = 0; i < 8; i++) s.finish(`k${i}`);
    expect(started).toHaveLength(16);
    // Under the limit again: one more starts.
    s.finish("k8");
    expect(started).toHaveLength(17);
    expect(s.inflight.size).toBe(8);
    s.update(keys.slice(9), keys.length - 9, Infinity, 16);
    expect(s.inflight.size).toBe(15);
  });

  it("caps loads at 16 at rest and with a landing ahead, at 8 while moving to an unknown one", () => {
    expect(loadLimit(false, false)).toBe(LOADS_AT_REST);
    expect(loadLimit(false, true)).toBe(LOADS_AT_REST);
    expect(loadLimit(true, true)).toBe(LOADS_AT_REST);
    expect(loadLimit(true, false)).toBe(LOADS_MOVING);
    expect([LOADS_AT_REST, LOADS_MOVING]).toEqual([16, 8]);
  });

  it("does not restart a finished tile unless asked again", () => {
    const start = vi.fn(() => () => {});
    const s = new TileScheduler(4, start);
    s.update(["a"]);
    s.finish("a");
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("TerrainTiles", () => {
  /** A stand-in for the tile worker: records loads, and answers when told. */
  class FakeWorker {
    static last: FakeWorker;
    loads: { key: string; low: boolean }[] = [];
    cancels: string[] = [];
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor() {
      FakeWorker.last = this;
    }
    postMessage(m: { type: string; key: string; low?: boolean }) {
      if (m.type === "load") this.loads.push({ key: m.key, low: !!m.low });
      if (m.type === "cancel") this.cancels.push(m.key);
    }
    terminate() {}
    arrive(key: string, px = 256) {
      this.onmessage?.({ data: { key, bitmap: { width: px, height: px, close() {} } } });
    }
  }
  const doc: TilesDoc = { build: "b1", tileSize: 256, apron: 2, maxLevel: 7, gridLevel: 3, radius: R, source: "bridge", stale: false, waterLevel: 30, biomes: [], forest: "mask" };
  const g = () => {
    const drawn: number[][] = [];
    const ctx = { save() {}, restore() {}, scale() {}, drawImage: (...a: number[]) => drawn.push(a.slice(5)), imageSmoothingEnabled: true, imageSmoothingQuality: "high" };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
  };
  afterEach(() => vi.unstubAllGlobals());

  it("asks for level 0 at once, waits for it, then redraws only what an arriving tile changes", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const tiles = new TerrainTiles(doc);
    const w = FakeWorker.last;
    expect(w.loads[0]).toEqual({ key: "0/0/0@1", low: false });
    expect(w.loads.slice(1).every((l) => l.low)).toBe(true);
    expect(tiles.ready).toBe(false);
    w.arrive("0/0/0@1");
    expect(tiles.ready).toBe(true);
    const { view, box } = phone(0.3);
    const { ctx, drawn } = g();
    tiles.draw(ctx, box, view, 0.3, 2);
    expect(drawn.length).toBe(tilesIn(box, 6, R).length);
    expect(tiles.changed()).toEqual([]);
    // The visible level 6 tiles are asked for, painted 1:1, ahead of everything else.
    const first = tilesIn(view, 6, R)[0]!;
    expect(w.loads.some((l) => l.key === `${tileKey(first)}@1` && !l.low)).toBe(true);
    w.arrive(`${tileKey(first)}@1`);
    expect(tiles.changed()).toEqual([tileBox(first, R)]);
    // Drawing just that box brings the base up to date.
    drawn.length = 0;
    tiles.draw(ctx, box, view, 0.3, 2, [tileBox(first, R)]);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(10);
    expect(tiles.changed()).toEqual([]);
    tiles.dispose();
  });

  it("loads a fling's landing ahead of the view, also when the map is drawn again on the way", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const tiles = new TerrainTiles(doc);
    const w = FakeWorker.last;
    w.arrive("0/0/0@1");
    const { ctx } = g();
    const here = phone(0.3);
    const running = () => tiles.coverage(here.view, 0.3, 2).inflight;
    const from = w.loads.length;
    tiles.draw(ctx, here.box, here.view, 0.3, 2);
    expect(running()).toBe(LOADS_AT_REST);
    const arrived = new Set<string>();
    // Answers the n oldest loads the view started.
    const land = (n: number) => {
      for (const l of w.loads.slice(from).filter((l) => !arrived.has(l.key) && !l.low).slice(0, n)) {
        arrived.add(l.key);
        w.arrive(l.key);
      }
    };
    // A drag, landing unknown: what runs goes on, nothing new starts above 8.
    tiles.motion(true, null, 2);
    expect(running()).toBe(LOADS_AT_REST);
    const before = w.loads.length;
    land(LOADS_AT_REST - LOADS_MOVING);
    expect(running()).toBe(LOADS_MOVING);
    expect(w.loads.length).toBe(before);
    // The finger lifts: the landing's tiles start, up to 16 at once.
    const landing = phone(0.3, 2000, -1500).view;
    const ahead = new Set(tilesIn(landing, 6, R).map((t) => `${tileKey(t)}@1`));
    tiles.motion(true, { view: landing, scale: 0.3 }, 2);
    expect(running()).toBe(LOADS_AT_REST);
    const fresh = w.loads.slice(before).map((l) => l.key);
    expect(fresh).toHaveLength(LOADS_AT_REST - LOADS_MOVING);
    expect(fresh.every((k) => ahead.has(k))).toBe(true);
    // Halfway, the cached picture runs out and the map is drawn again: the landing still comes first.
    // (The view's loads left behind are cancelled, and the freed slots go to the landing, not the new view.)
    const mid = phone(0.3, -800, -600);
    const n = w.loads.length;
    tiles.draw(ctx, mid.box, mid.view, 0.3, 2);
    const refill = w.loads.slice(n).map((l) => l.key);
    expect(refill.length).toBeGreaterThan(0);
    expect(refill.every((k) => ahead.has(k))).toBe(true);
    expect(running()).toBe(LOADS_AT_REST);
    // At rest on the landing (whose cached picture may need no new draw): what it still waits for keeps loading.
    const cancelled = w.cancels.length;
    tiles.motion(false, null, 2);
    expect(w.cancels.slice(cancelled).filter((k) => ahead.has(k))).toEqual([]);
    expect(running()).toBe(LOADS_AT_REST);
    tiles.dispose();
  });

  it("keeps levels 0-3 for good, outside the cache budget", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const tiles = new TerrainTiles(doc, 1024 * 1024);
    const w = FakeWorker.last;
    for (const t of pinnedTiles(7, R)) w.arrive(`${tileKey(t)}@1`);
    // Fine tiles past the 1 MiB budget push each other out; the pinned ones stay.
    for (let x = 0; x < 8; x++) w.arrive(`6/${30 + x}/30@1`);
    const h = tiles.held;
    expect(h.pinnedTiles).toBe(pinnedTiles(7, R).length);
    expect(h.bytes - h.pinnedBytes).toBeLessThanOrEqual(1024 * 1024);
    tiles.dispose();
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
