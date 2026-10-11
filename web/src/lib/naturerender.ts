// Nature on the parchment: woods as washes of ink with a darker rim, rocks as
// grey stones, stumps, logs, bushes and, close in, pickables as small dots.
// Geometry is built once per loaded chunk into Path2Ds in world units, by
// category and tint; a draw only fills and strokes the chunks the view
// touches, with widths in screen pixels. Ore is drawn by the renderer in
// screen space every frame, so it keeps its size during a pinch and can be
// tapped.

import type { ChunkKey } from "./pieces";
import { chunkBox } from "./pieces";
import { NATURE_CHUNK, NATURE_FADE_FROM, NATURE_FADE_FULL, natureTint, PICKABLE_SCALE, TREE_DETAIL_SCALE, wobble, type NatureItem } from "./nature";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The widest anything reaches past its chunk (a big crown, a cliff), in metres. */
const SPILL = 12;

interface ChunkPaths {
  box: [number, number, number, number];
  /** Crowns by tint, in the order they are laid down; `coarse` the same as plain polygons, for mid zoom. */
  crowns: Map<string, Path2D>;
  coarse: Map<string, Path2D>;
  trunks: Path2D;
  stumps: Path2D;
  logs: Path2D;
  rocks: Map<string, Path2D>;
  cliffs: Path2D;
  bushes: Path2D;
  /** Points, stroked as dots a few pixels wide, by tint. */
  pickables: Map<string, Path2D>;
  ores: NatureItem[];
  trees: number;
}

const bucket = (m: Map<string, Path2D>, k: string) => {
  let p = m.get(k);
  if (!p) m.set(k, (p = new Path2D()));
  return p;
};

/** A crown for mid zoom, where a few pixels across cannot show lobes: a plain polygon, far cheaper to fill. */
function crownCoarse(path: Path2D, it: NatureItem) {
  const r = (it.size / 2) * (1 + 0.07 * wobble(it, 99));
  const a0 = (it.yaw * Math.PI) / 180;
  for (let i = 0; i < 11; i++) {
    const a = a0 + (i / 11) * Math.PI * 2;
    const ri = r * (1.04 + 0.08 * wobble(it, i));
    if (i === 0) path.moveTo(it.x + Math.cos(a) * ri, it.z + Math.sin(a) * ri);
    else path.lineTo(it.x + Math.cos(a) * ri, it.z + Math.sin(a) * ri);
  }
  path.closePath();
}

/** A crown: a soft lobed ring, each lobe a little in or out, turned by the tree's yaw. */
function crown(path: Path2D, it: NatureItem) {
  const r = (it.size / 2) * (1 + 0.07 * wobble(it, 99));
  const n = 7;
  const a0 = (it.yaw * Math.PI) / 180;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    const ri = r * (1 + 0.1 * wobble(it, i));
    pts.push([it.x + Math.cos(a) * ri, it.z + Math.sin(a) * ri]);
  }
  const mid = (i: number) => {
    const p = pts[i % n]!;
    const q = pts[(i + 1) % n]!;
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as const;
  };
  // Through the midpoints, bowed out towards each point: round lobes.
  const m0 = mid(0);
  path.moveTo(m0[0], m0[1]);
  for (let i = 1; i <= n; i++) {
    const p = pts[i % n]!;
    const m = mid(i);
    path.quadraticCurveTo(p[0] + (p[0] - it.x) * 0.12, p[1] + (p[1] - it.z) * 0.12, m[0], m[1]);
  }
  path.closePath();
}

/** A stone: an irregular polygon seeded by the item, so the same rock keeps its shape. */
function stone(path: Path2D, it: NatureItem, corners = 7, rough = 0.28) {
  const r = it.size / 2;
  const a0 = (it.yaw * Math.PI) / 180;
  for (let i = 0; i < corners; i++) {
    const a = a0 + ((i + 0.3 * wobble(it, 40 + i)) / corners) * Math.PI * 2;
    const ri = r * (1 + rough * wobble(it, i));
    const x = it.x + Math.cos(a) * ri;
    const z = it.z + Math.sin(a) * ri;
    if (i === 0) path.moveTo(x, z);
    else path.lineTo(x, z);
  }
  path.closePath();
}

const dot = (path: Path2D, x: number, z: number) => {
  path.moveTo(x - 0.001, z);
  path.lineTo(x + 0.001, z);
};

function build(key: ChunkKey, items: readonly NatureItem[]): ChunkPaths {
  const out: ChunkPaths = { box: chunkBox(key, NATURE_CHUNK), crowns: new Map(), coarse: new Map(), trunks: new Path2D(), stumps: new Path2D(), logs: new Path2D(), rocks: new Map(), cliffs: new Path2D(), bushes: new Path2D(), pickables: new Map(), ores: [], trees: 0 };
  // The big crowns first, so smaller trees sit on top of them.
  const trees = items.filter((it) => it.category === "tree").sort((a, b) => b.size - a.size);
  for (const it of trees) {
    crown(bucket(out.crowns, natureTint("tree", it.species)), it);
    crownCoarse(bucket(out.coarse, natureTint("tree", it.species)), it);
    dot(out.trunks, it.x, it.z);
  }
  out.trees = trees.length;
  for (const it of items) {
    switch (it.category) {
      case "stump": {
        const r = it.size / 2;
        out.stumps.moveTo(it.x + r, it.z);
        out.stumps.arc(it.x, it.z, r, 0, Math.PI * 2);
        break;
      }
      case "log": {
        const a = (it.yaw * Math.PI) / 180;
        // Along the log's local x: (cos yaw, -sin yaw) in world x, z, as pieces turn.
        const dx = (Math.cos(a) * it.size) / 2;
        const dz = (-Math.sin(a) * it.size) / 2;
        out.logs.moveTo(it.x - dx, it.z - dz);
        out.logs.lineTo(it.x + dx, it.z + dz);
        break;
      }
      case "rock":
        if (it.species === "cliff") stone(out.cliffs, it, 9, 0.35);
        else stone(bucket(out.rocks, natureTint("rock", it.species)), it);
        break;
      case "bush": {
        const r = (it.size / 2) * (1 + 0.15 * wobble(it, 7));
        out.bushes.moveTo(it.x + r, it.z);
        out.bushes.arc(it.x, it.z, r, 0, Math.PI * 2);
        break;
      }
      case "pickable":
        dot(bucket(out.pickables, natureTint("pickable", it.species)), it.x, it.z);
        break;
      case "ore":
        out.ores.push(it);
        break;
    }
  }
  return out;
}

/** A tint darkened towards the ink, for rims and outlines. */
function darker(hex: string, k = 0.55): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) * k + 40 * (1 - k));
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

/** How strongly nature shows at this scale. */
export function natureAlpha(scale: number): number {
  const t = Math.min(1, Math.max(0, (scale - NATURE_FADE_FROM) / (NATURE_FADE_FULL - NATURE_FADE_FROM)));
  return t * t * (3 - 2 * t);
}

export class NatureLayer {
  private chunks = new Map<ChunkKey, { items: readonly NatureItem[]; paths: ChunkPaths | null }>();
  /** Bumped whenever a chunk arrives or leaves, for the renderer's cache key. */
  version = 0;
  private scratch: HTMLCanvasElement | OffscreenCanvas | null = null;

  /** The loaded chunks; paths are kept for chunks whose items did not change. */
  set(loaded: ReadonlyMap<ChunkKey, readonly NatureItem[]>): void {
    const next = new Map<ChunkKey, { items: readonly NatureItem[]; paths: ChunkPaths | null }>();
    for (const [k, items] of loaded) {
      const had = this.chunks.get(k);
      next.set(k, had && had.items === items ? had : { items, paths: null });
    }
    this.chunks = next;
    this.version++;
  }

  get empty(): boolean {
    return this.chunks.size === 0;
  }

  private visible(box: readonly [number, number, number, number]): ChunkPaths[] {
    const out: ChunkPaths[] = [];
    for (const [k, c] of this.chunks) {
      const b = chunkBox(k, NATURE_CHUNK);
      if (b[2] + SPILL < box[0] || b[0] - SPILL > box[2] || b[3] + SPILL < box[1] || b[1] - SPILL > box[3]) continue;
      if (typeof Path2D === "undefined") continue;
      c.paths ??= build(k, c.items);
      out.push(c.paths);
    }
    return out;
  }

  /** Ore deposits in `box`, for the renderer's screen-space pass. */
  ores(box: readonly [number, number, number, number]): NatureItem[] {
    const out: NatureItem[] = [];
    for (const c of this.visible(box)) for (const o of c.ores) if (o.x >= box[0] && o.x <= box[2] && o.z >= box[1] && o.z <= box[3]) out.push(o);
    return out;
  }

  /**
   * Draws what the view's box holds under a world transform (x right, z up)
   * for view scale `scale`: `nature` the woods, rocks and the rest, `pickables`
   * the small things to gather (from PICKABLE_SCALE on).
   */
  draw(g: Ctx, box: readonly [number, number, number, number], scale: number, layers: { nature: boolean; pickables: boolean }, rough = false): void {
    const alpha = natureAlpha(scale);
    if (alpha <= 0) return;
    const list = this.visible(box);
    if (!list.length) return;
    const px = 1 / scale;
    const detail = scale >= TREE_DETAIL_SCALE;
    g.save();
    g.lineJoin = "round";
    g.lineCap = "round";
    if (layers.nature) {
      // Ground first: logs, stumps, stones and bushes, the woods over them.
      g.globalAlpha = alpha * 0.85;
      g.strokeStyle = "#6a4a2c";
      g.lineWidth = Math.max(1.4 * px, 0.5);
      for (const c of list) g.stroke(c.logs);
      g.fillStyle = "rgba(226, 204, 160, 0.9)";
      g.strokeStyle = "#5d4026";
      g.lineWidth = 1 * px;
      for (const c of list) {
        g.fill(c.stumps);
        g.stroke(c.stumps);
      }
      for (const c of list) {
        for (const [tint, path] of c.rocks) {
          g.fillStyle = tint;
          g.fill(path);
          g.strokeStyle = darker(tint, 0.4);
          g.lineWidth = 1.1 * px;
          g.stroke(path);
        }
        g.fillStyle = "rgba(150, 140, 126, 0.45)";
        g.fill(c.cliffs);
        g.strokeStyle = "#3a2a1a";
        g.lineWidth = 1.4 * px;
        g.stroke(c.cliffs);
      }
      g.fillStyle = "rgba(146, 170, 96, 0.6)";
      g.strokeStyle = "rgba(70, 92, 40, 0.55)";
      g.lineWidth = 0.8 * px;
      for (const c of list) {
        g.fill(c.bushes);
        if (detail) g.stroke(c.bushes);
      }
      this.drawWoods(g, list, scale, alpha, rough);
      if (detail) {
        // Close in, every tree its own: a faint rim round each crown and its trunk.
        const near = Math.min(1, (scale - TREE_DETAIL_SCALE) / 4);
        g.globalAlpha = alpha * (0.15 + 0.2 * near);
        g.strokeStyle = "#2f3a1c";
        g.lineWidth = 0.8 * px;
        for (const c of list) for (const path of c.crowns.values()) g.stroke(path);
        g.globalAlpha = alpha * 0.85;
        g.strokeStyle = "#4a3320";
        g.lineWidth = Math.max(2.2 * px, 0.4);
        for (const c of list) g.stroke(c.trunks);
      }
    }
    if (layers.pickables && scale >= PICKABLE_SCALE) {
      // Small dots with a dark edge: a wider dark stroke under the colour.
      const w = Math.max(5 * px, 0.45);
      g.globalAlpha = alpha;
      g.strokeStyle = "rgba(43, 29, 18, 0.85)";
      g.lineWidth = w + 1.6 * px;
      for (const c of list) for (const path of c.pickables.values()) g.stroke(path);
      g.lineWidth = w;
      for (const c of list) {
        for (const [tint, path] of c.pickables) {
          g.strokeStyle = tint;
          g.stroke(path);
        }
      }
    }
    g.restore();
  }

  /**
   * The woods: each tint's crowns filled in ink a pixel or two down and
   * right, then in their tint over it, on a layer of their own; laid on the
   * map as one wash, only a wood's outer edge keeps the ink, so a forest
   * reads as one mass rather than a heap of circles.
   */
  private drawWoods(g: Ctx, list: readonly ChunkPaths[], scale: number, alpha: number, rough: boolean) {
    if (!list.some((c) => c.trees > 0)) return;
    // While the map moves, the layer is drawn at half resolution (a quarter of
    // the pixels; nobody sees it) into its top-left corner.
    const k = rough ? 0.5 : 1;
    const FW = g.canvas.width;
    const FH = g.canvas.height;
    const W = Math.ceil(FW * k);
    const H = Math.ceil(FH * k);
    if (!this.scratch || this.scratch.width !== FW || this.scratch.height !== FH) {
      this.scratch = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(FW, FH) : Object.assign(document.createElement("canvas"), { width: FW, height: FH });
    }
    const s = this.scratch.getContext("2d") as Ctx | null;
    if (!s) return;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, W, H);
    const t = g.getTransform();
    const m = new DOMMatrix([t.a * k, t.b * k, t.c * k, t.d * k, t.e * k, t.f * k]);
    // The rim is the wood's own shape a little down and right, in ink: a
    // shadow on the far side, as a woodland is shaded on a drawn map. A fill
    // costs far less than stroking every crown.
    const off = (1.5 * m.a) / scale;
    const tints = new Set<string>();
    for (const c of list) for (const tint of c.crowns.keys()) tints.add(tint);
    const shape = (c: ChunkPaths) => (scale < TREE_DETAIL_SCALE ? c.coarse : c.crowns);
    for (const tint of tints) {
      s.setTransform(m.a, m.b, m.c, m.d, m.e + off, m.f + off);
      s.fillStyle = darker(tint, 0.4);
      for (const c of list) {
        const p = shape(c).get(tint);
        if (p) s.fill(p);
      }
      s.setTransform(m);
      s.fillStyle = tint;
      for (const c of list) {
        const p = shape(c).get(tint);
        if (p) s.fill(p);
      }
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = alpha * 0.62;
    g.drawImage(this.scratch as CanvasImageSource, 0, 0, W, H, 0, 0, FW, FH);
    g.restore();
  }
}
