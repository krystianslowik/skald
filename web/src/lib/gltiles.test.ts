import { afterEach, describe, expect, it, vi } from "vitest";
import { mockTerrainTile } from "@server/mocktiles";
import { fogField } from "./fogfield";
import { closeColour, Fades, FADE_MS, flatColour, heldLevel, HYSTERESIS, LOAD_GATE_MS, loadAllowance, MOVING_STARTS, premultiply, selfTestTile, slotQuads, subRect, TexturePool, UploadBudget, Watchdog } from "./gltiles";
import { chunkCapacity, poolCapacity, TILE_EDGE } from "./mapgl";
import { boldFaceReady, canvasForced, RENDERER_KEY } from "./maprender";
import { TileFeed } from "./terraindata";
import { decodeTile, packTile, paintTile, paletteOf } from "./terrainpaint";
import { levelFor, planView, tileKey, type TileRef, type TilesDoc } from "./terraintiles";

const R = 10500;

describe("texture pool", () => {
  it("hands out free layers first, then the least recently used one not kept", () => {
    const pool = new TexturePool(3);
    const none = () => false;
    expect(pool.acquire("a", none)).toEqual({ layer: 0, evicted: null });
    expect(pool.acquire("b", none)).toEqual({ layer: 1, evicted: null });
    expect(pool.acquire("c", none)).toEqual({ layer: 2, evicted: null });
    // A tile already in keeps its layer.
    expect(pool.acquire("a", none)).toEqual({ layer: 0, evicted: null });
    // "a" was just used, so "b" is the oldest; "b" is kept, so "c" goes.
    expect(pool.acquire("d", (k) => k === "b")).toEqual({ layer: 2, evicted: "c" });
    expect(pool.has("c")).toBe(false);
    expect(pool.layer("d")).toBe(2);
    pool.touch("b");
    expect(pool.acquire("e", none)).toEqual({ layer: 0, evicted: "a" });
  });

  it("refuses when every layer is kept, and frees what it is told to", () => {
    const pool = new TexturePool(2);
    pool.acquire("0:1/0/0", () => false);
    pool.acquire("1:1/0/0", () => false);
    expect(pool.acquire("x", () => true)).toBeNull();
    pool.deleteWhere((k) => k.startsWith("0:"));
    expect(pool.size).toBe(1);
    expect(pool.acquire("x", () => true)).toEqual({ layer: 0, evicted: null });
    pool.clear();
    expect(pool.size).toBe(0);
    expect(pool.acquire("y", () => true)?.layer).toBe(0);
  });

  it("sizes the pools for the screen within the device's limits", () => {
    // A phone at 2x: two screens of tiles and the pinned floor, under 256 layers.
    const phone = poolCapacity(780, 1688, 2048);
    expect(phone).toBeGreaterThan(100);
    expect(phone).toBeLessThanOrEqual(256);
    expect(phone * TILE_EDGE * TILE_EDGE * 4).toBeLessThan(48 * 1024 * 1024);
    expect(poolCapacity(780, 1688, 2048, 4)).toBeLessThanOrEqual(128);
    expect(poolCapacity(5120, 2880, 256)).toBe(256);
    expect(poolCapacity(100, 100, 2048)).toBe(64);
    expect(chunkCapacity(780, 1688, 2048)).toBeLessThanOrEqual(160);
    expect(chunkCapacity(780, 1688, 2048, 4)).toBeLessThanOrEqual(112);
  });
});

describe("upload budget", () => {
  it("allows at most `max` a frame, and none past the time, but always one", () => {
    const b = new UploadBudget(3, 3);
    b.begin(100);
    expect([b.take(100), b.take(101), b.take(101.5), b.take(101.6)]).toEqual([true, true, true, false]);
    expect(b.used).toBe(3);
    // A slow first upload still goes; the next one waits for the next frame.
    b.begin(200);
    expect(b.take(250)).toBe(true);
    expect(b.take(250)).toBe(false);
    // A new frame starts over.
    b.begin(300);
    expect(b.take(300)).toBe(true);
    expect(b.used).toBe(1);
  });
});

describe("load gate", () => {
  it("starts any number of loads at rest, a couple while moving, none in a frame already late", () => {
    expect(loadAllowance(false, 0, 30)).toBe(Infinity);
    expect(loadAllowance(true, 100, 104)).toBe(MOVING_STARTS);
    expect(loadAllowance(true, 100, 100 + LOAD_GATE_MS + 0.1)).toBe(0);
    // Outside a frame (an arrival's redraw) there is nothing to measure against.
    expect(loadAllowance(true, undefined, 500)).toBe(MOVING_STARTS);
  });
});

describe("crossfade", () => {
  it("eases a tile in over FADE_MS from when it began, and forgets it after", () => {
    const f = new Fades();
    expect(FADE_MS).toBeGreaterThanOrEqual(200);
    expect(FADE_MS).toBeLessThanOrEqual(300);
    expect(f.alpha("a", 0)).toBe(1);
    f.begin("a", 1000);
    expect(f.alpha("a", 1000)).toBe(0);
    expect(f.alpha("a", 1000 + FADE_MS / 2)).toBeCloseTo(0.5);
    expect(f.alpha("a", 1000 + FADE_MS / 4)).toBeLessThan(0.25);
    expect(f.busy(1000 + FADE_MS - 1)).toBe(true);
    expect(f.alpha("a", 1000 + FADE_MS)).toBe(1);
    expect(f.busy(1000 + FADE_MS)).toBe(false);
    // Begun again (a level change), it fades again.
    f.begin("a", 2000);
    expect(f.alpha("a", 2000 + FADE_MS / 2)).toBeCloseTo(0.5);
    f.drop("a");
    expect(f.alpha("a", 2001)).toBe(1);
  });

  it("holds the level until the zoom is clearly past a boundary", () => {
    // Find a boundary: the scale where levelFor steps from z to z + 1.
    let s = 0.1;
    const z = levelFor(s, 2, 7, R);
    while (levelFor(s, 2, 7, R) === z) s *= 1.001;
    expect(heldLevel(s, 2, 7, R, 256, z)).toBe(z);
    expect(heldLevel(s * 2 ** (HYSTERESIS + 0.01), 2, 7, R, 256, z)).toBe(z + 1);
    // And back down: held at z + 1 just below the boundary.
    expect(heldLevel(s / 1.002, 2, 7, R, 256, z + 1)).toBe(z + 1);
    expect(heldLevel(s * 2 ** -(HYSTERESIS + 0.01), 2, 7, R, 256, z + 1)).toBe(z);
    // Far jumps and the first frame take levelFor as it is.
    expect(heldLevel(s * 8, 2, 7, R, 256, z)).toBe(levelFor(s * 8, 2, 7, R));
    expect(heldLevel(s, 2, 7, R, 256, undefined)).toBe(levelFor(s, 2, 7, R));
  });
});

describe("relative selection", () => {
  const box = { x0: -400, z0: -400, x1: 400, z1: 400 };
  const plan = (has: (t: TileRef) => boolean) => planView({ box, view: box, scale: 0.3, dpr: 2, maxLevel: 7, radius: R, has });

  it("draws a missing tile from its nearest loaded ancestor, cut to its area", () => {
    const z = plan(() => false).z;
    const loaded = new Set(["0/0/0"]);
    const p = plan((t) => loaded.has(tileKey(t)));
    const q = slotQuads(p.slots, () => null);
    expect(q.blank).toBe(0);
    expect(q.ancestor).toBe(p.slots.length);
    expect(q.quads.every((x) => tileKey(x.src) === "0/0/0" && x.dst.z === z && x.alpha === 1)).toBe(true);
    expect(q.used).toEqual(new Set(["0/0/0"]));
    // The ancestor's part that covers the slot.
    const s = p.slots[0]!.tile;
    const [s0, t0, s1, t1] = subRect({ z: 0, x: 0, y: 0 }, s);
    expect(s1 - s0).toBeCloseTo(1 / 2 ** z);
    expect(s0).toBeCloseTo(s.x / 2 ** z);
    expect(t0).toBeCloseTo(s.y / 2 ** z);
    expect(t1 - t0).toBeCloseTo(1 / 2 ** z);
  });

  it("draws a missing tile from its children, over the ancestor where they leave gaps", () => {
    const z = plan(() => false).z;
    const t = plan(() => false).slots[0]!.tile;
    const kids = [0, 1, 2].map((i) => ({ z: z + 1, x: 2 * t.x + (i & 1), y: 2 * t.y + (i >> 1) }));
    const loaded = new Set(["0/0/0", ...kids.map(tileKey)]);
    const p = plan((x) => loaded.has(tileKey(x)));
    const slot = p.slots.find((s) => tileKey(s.tile) === tileKey(t))!;
    const q = slotQuads([slot], () => null);
    // Three children, so the ancestor fills the fourth quarter: drawn first, under them.
    expect(q.quads.map((x) => tileKey(x.src))).toEqual(["0/0/0", ...kids.map(tileKey)]);
    expect(q.blank).toBe(0);
  });

  it("fades a tile in over its stand-ins, and blanks only with nothing loaded at all", () => {
    const p = plan(() => false);
    const t = p.slots[0]!.tile;
    // On the GPU but fading: planned as missing, drawn last with its alpha.
    const loaded = new Set(["0/0/0"]);
    const pp = plan((x) => loaded.has(tileKey(x)));
    const q = slotQuads(pp.slots, (x) => (tileKey(x) === tileKey(t) ? 0.4 : null));
    const own = q.quads.filter((x) => tileKey(x.src) === tileKey(t));
    expect(own).toEqual([{ src: t, dst: t, alpha: 0.4 }]);
    expect(q.quads.indexOf(own[0]!)).toBe(1);
    expect(q.fading).toBe(1);
    // Nothing loaded anywhere: every slot is blank (only before level 0 arrives).
    expect(slotQuads(p.slots, () => null).blank).toBe(p.slots.length);
    // A loaded tile done fading is drawn alone.
    const done = slotQuads(plan(() => true).slots, () => null);
    expect(done.quads.every((x) => x.src === x.dst && x.alpha === 1)).toBe(true);
    expect(done.own).toBe(p.slots.length);
  });
});

describe("tile data", () => {
  it("packs biome, forest and height into one texel per sample, apron included", () => {
    const raw = mockTerrainTile(5, 10, 15)!;
    const t = decodeTile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
    expect(t.n).toBe(TILE_EDGE);
    const px = packTile(t, paletteOf(null).meanForest);
    expect(px).toHaveLength(TILE_EDGE * TILE_EDGE * 4);
    for (const i of [0, 777, TILE_EDGE * TILE_EDGE - 1]) {
      expect(px[4 * i]).toBe(t.biomes[i]);
      expect((px[4 * i + 2]! << 8) | px[4 * i + 3]!).toBe(t.heights[i]);
      expect(px[4 * i + 1]).toBe(t.forest ? t.forest[i] : expect.any(Number));
    }
    // Without a forest channel, the biome's mean (as paintTile uses).
    const bare = packTile({ ...t, forest: null }, paletteOf(null).meanForest);
    const i = t.biomes.findIndex((b) => b === 4);
    if (i >= 0) expect(bare[4 * i + 1]).toBe(Math.round(paletteOf(null).meanForest[4]! * 255));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("asks for tiles in order, keeping the low-priority tail low and skipping what it holds", () => {
    const posted: { type: string; key: string }[] = [];
    class FakeWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      postMessage(m: { type: string; key: string }) {
        posted.push(m);
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", FakeWorker);
    const doc = { build: "b", tileSize: 256, apron: 2, maxLevel: 7, radius: R, palette: null } as unknown as TilesDoc;
    const feed = new TileFeed(doc, { workers: 2, concurrency: 2 });
    feed.want(["0/0/0", "3/1/1", "3/1/2"], 1);
    // Two at once, the low tail one at a time: the second low one waits.
    expect(posted.filter((m) => m.type === "load").map((m) => m.key)).toEqual(["0/0/0", "3/1/1"]);
    feed.want(["3/1/1", "3/1/2"], 2);
    // "0/0/0" no longer wanted: cancelled; both, now high, run.
    expect(posted.filter((m) => m.type === "cancel").map((m) => m.key)).toEqual(["0/0/0"]);
    expect(posted.filter((m) => m.type === "load").map((m) => m.key)).toEqual(["0/0/0", "3/1/1", "3/1/2"]);
    feed.dispose();
  });
});

describe("fog field", () => {
  it("is the signed distance to the explored outline, negative inside, exact near the edge", () => {
    // A square 1 km a side, traced as the map worker traces explored areas.
    const sq = Float32Array.from([-500, -500, 500, -500, 500, 500, -500, 500]);
    const f = fogField([sq], 12)!;
    expect(f).not.toBeNull();
    const at = (x: number, z: number) => f.data[Math.floor((z - f.z0) / f.cell) * f.w + Math.floor((x - f.x0) / f.cell)]!;
    expect(at(0, 0)).toBeLessThan(-400);
    expect(at(0, 1300)).toBeGreaterThan(700);
    // Near the edge, the exact distance to the outline, not a cell's step.
    const i = Math.floor((503 - f.x0) / f.cell);
    const cx = f.x0 + (i + 0.5) * f.cell;
    expect(at(503, 0)).toBeCloseTo(cx - 500, 3);
    // Nothing explored: no field (fog everywhere).
    expect(fogField([], 12)).toBeNull();
  });
});

describe("mark badges", () => {
  it("are kept once the bold face is in, even with a second copy of the faces never used", () => {
    const face = (weight: string, status: FontFaceLoadStatus) => ({ family: '"Averia Serif Libre"', weight, status });
    // The stylesheet registered twice: one copy loaded, the other never will be. check() says false here for good.
    expect(boldFaceReady([face("400", "unloaded"), face("700", "unloaded"), face("400", "loaded"), face("700", "loaded")])).toBe(true);
    expect(boldFaceReady([face("700", "loading")])).toBe(false);
    expect(boldFaceReady([face("700", "error")])).toBe(true);
    expect(boldFaceReady([])).toBe(true);
  });
});

describe("WebGL safety", () => {
  afterEach(() => localStorage.removeItem(RENDERER_KEY));

  it("is switched off by ?map=canvas or by localStorage", () => {
    expect(canvasForced("")).toBe(false);
    expect(canvasForced("?map=canvas")).toBe(true);
    expect(canvasForced("?x=1&map=canvas")).toBe(true);
    expect(canvasForced("?map=gl")).toBe(false);
    localStorage.setItem(RENDERER_KEY, "canvas");
    expect(canvasForced("")).toBe(true);
  });

  it("self-tests against what paintTile makes of the same tile", () => {
    const t = selfTestTile(TILE_EDGE, 1, 31500);
    expect(t).toHaveLength(TILE_EDGE * TILE_EDGE * 4);
    expect([t[0], t[1], (t[2]! << 8) | t[3]!]).toEqual([1, 0, 31500]);
    // paintTile on that tile, decoded the way the bridge's tiles are: flat Meadows, dry, no forest.
    // With a forest channel of zeros, as the self-test tile has.
    const raw = new Uint8Array(24 + TILE_EDGE * TILE_EDGE * 4);
    const dv = new DataView(raw.buffer);
    dv.setUint32(0, 0x31544b53, true);
    dv.setUint16(4, 1, true);
    dv.setUint16(6, 1, true);
    dv.setInt32(8, TILE_EDGE, true);
    dv.setFloat32(20, 0.64, true);
    for (let i = 0; i < TILE_EDGE * TILE_EDGE; i++) {
      raw[24 + i] = 1;
      dv.setUint16(24 + TILE_EDGE * TILE_EDGE + 2 * i, 31500, true);
    }
    const px = paintTile(decodeTile(raw.buffer), { factor: 1, palette: paletteOf(null), waterLevel: 30, radius: R });
    const want = flatColour(paletteOf(null).biome[1]!).map(Math.round);
    expect([...px.subarray(4 * 1000, 4 * 1000 + 3)]).toEqual(want);
    expect(closeColour([10, 20, 30, 255], [12, 18, 30, 255], 4)).toBe(true);
    expect(closeColour([0, 0, 0, 0], [200, 100, 50, 255], 4)).toBe(false);
  });

  it("premultiplies chunk pixels for upload", () => {
    const px = new Uint8ClampedArray([200, 100, 50, 255, 200, 100, 50, 128, 9, 9, 9, 0]);
    expect([...premultiply(px)]).toEqual([200, 100, 50, 255, 100, 50, 25, 128, 0, 0, 0, 0]);
  });

  it("gives up on tiles stuck off the GPU, or on a feed that only fails", () => {
    const w = new Watchdog(5000, 8);
    expect(w.frame(0, true, { ok: 5, errors: 0 })).toBeNull();
    expect(w.frame(3000, true, { ok: 5, errors: 0 })).toBeNull();
    // Unstuck in between: the clock starts over.
    expect(w.frame(4000, false, { ok: 5, errors: 0 })).toBeNull();
    expect(w.frame(4100, true, { ok: 5, errors: 0 })).toBeNull();
    expect(w.frame(9000, true, { ok: 5, errors: 0 })).toBeNull();
    expect(w.frame(9200, true, { ok: 5, errors: 0 })).toMatch(/GPU/);
    // Reported once.
    expect(w.frame(9300, true, { ok: 5, errors: 0 })).toBeNull();
    const d = new Watchdog(5000, 8);
    expect(d.frame(0, false, { ok: 0, errors: 7 })).toBeNull();
    expect(d.frame(1, false, { ok: 0, errors: 8 })).toMatch(/decode/);
    // Some tiles fine: a few errors are not a broken pipeline.
    expect(new Watchdog(5000, 8).frame(0, false, { ok: 3, errors: 20 })).toBeNull();
  });
});
