// Floor plans on the parchment: bases drawn as an inked building plan at
// close zoom. Geometry is built once per base and storey into Path2Ds in
// world units; a draw only strokes them with widths in screen pixels, so
// they stay crisp at any zoom and cost nothing to rebuild while panning.

import { activeBase, baseAt, groupBases, pieceCorners, pieceLocal, pieceStorey, storeyOf, type Base, type Piece } from "./pieces";
import type { View } from "./mapgeo";

/** Below this scale (px per metre) nothing is drawn or fetched; full strength from FULL on. */
export const PLAN_MIN_SCALE = 1.2;
export const PLAN_FULL_SCALE = 2;
/** The floor switcher shows from this scale on. */
export const STOREY_SCALE = 2;

/** The storey picked for one base: an index into its levels, or levels.length for the roofs. */
export interface StoreyPick {
  base: string;
  level: number;
}

/** What the floor switcher needs to know about the base it is for. */
export interface StoreyInfo {
  base: string;
  storeys: number;
  hasRoof: boolean;
}

const INK = "#3a2a1a";
const FLOOR = "rgba(232, 214, 172, 0.92)";
const FLOOR_LINE = "rgba(58, 42, 26, 0.38)";
const TINT: Partial<Record<Piece["kind"], [fill: string, line: string]>> = {
  station: ["rgba(178, 86, 40, 0.42)", "rgba(110, 44, 18, 0.95)"],
  furniture: ["rgba(128, 92, 52, 0.22)", "rgba(84, 58, 32, 0.85)"],
  storage: ["rgba(205, 146, 58, 0.55)", "rgba(96, 60, 22, 0.95)"],
  light: ["rgba(226, 128, 34, 0.45)", "rgba(140, 66, 12, 0.95)"],
  portal: ["rgba(94, 151, 204, 0.3)", "rgba(33, 70, 95, 0.95)"],
  plant: ["rgba(96, 124, 52, 0.55)", "rgba(56, 78, 28, 0.9)"],
};
const ROOF_FILL = "rgba(150, 74, 42, 0.14)";
const ROOF_INK = "rgba(112, 52, 30, 0.42)";
const ROOF_EDGE = "rgba(112, 52, 30, 0.22)";
const ACTIVE = "rgba(33, 70, 95, 0.6)";

/** Everything one storey of one base draws, by how it is stroked. */
interface Paths {
  floors: Path2D;
  /** Walls by thickness (metres), stroked along their length. */
  walls: Map<number, Path2D>;
  doors: Path2D;
  fences: Path2D;
  beams: Path2D;
  /** Points, stroked as squares at least a few pixels wide; by thickness. */
  poles: Map<number, Path2D>;
  stairs: Path2D;
  marks: Map<Piece["kind"], Path2D>;
  roofs: Path2D;
  hatch: Path2D;
  dots: Path2D;
  empty: boolean;
}

function newPaths(): Paths {
  return { floors: new Path2D(), walls: new Map(), doors: new Path2D(), fences: new Path2D(), beams: new Path2D(), poles: new Map(), stairs: new Path2D(), marks: new Map(), roofs: new Path2D(), hatch: new Path2D(), dots: new Path2D(), empty: true };
}

function rect(path: Path2D, p: Piece) {
  const c = pieceCorners(p);
  path.moveTo(c[0]![0], c[0]![1]);
  for (let i = 1; i < 4; i++) path.lineTo(c[i]![0], c[i]![1]);
  path.closePath();
}

function line(path: Path2D, p: Piece, ax: number, az: number, bx: number, bz: number) {
  const a = pieceLocal(p, ax, az);
  const b = pieceLocal(p, bx, bz);
  path.moveTo(a[0], a[1]);
  path.lineTo(b[0], b[1]);
}

const bucket = (m: Map<number, Path2D>, k: number) => {
  let p = m.get(k);
  if (!p) m.set(k, (p = new Path2D()));
  return p;
};

/** A door: the opening's threshold and the leaf swung open with its arc (two leaves for a gate). */
function door(path: Path2D, p: Piece) {
  const hw = p.w / 2;
  line(path, p, -hw, 0, hw, 0);
  const leaves: [hinge: number, dir: number, r: number][] = p.w >= 3 ? [[-hw, 1, hw], [hw, -1, hw]] : [[-hw, 1, p.w]];
  for (const [hx, dir, r] of leaves) {
    line(path, p, hx, 0, hx, r);
    const start = pieceLocal(p, hx + dir * r, 0);
    path.moveTo(start[0], start[1]);
    for (let k = 1; k <= 8; k++) {
      const a = (k / 8) * (Math.PI / 2);
      const q = pieceLocal(p, hx + dir * r * Math.cos(a), r * Math.sin(a));
      path.lineTo(q[0], q[1]);
    }
  }
}

/** A flight of stairs: its outline, the treads, and an arrow up (towards local -z). */
function stair(path: Path2D, p: Piece) {
  rect(path, p);
  const hw = p.w / 2;
  const hd = p.d / 2;
  const steps = Math.max(3, Math.round(p.d / 0.33));
  for (let k = 1; k < steps; k++) {
    const z = -hd + (k / steps) * p.d;
    line(path, p, -hw, z, hw, z);
  }
  const tip = -hd * 0.8;
  const head = Math.min(0.45, p.w * 0.25);
  line(path, p, 0, hd * 0.8, 0, tip);
  line(path, p, -head, tip + head, 0, tip);
  line(path, p, head, tip + head, 0, tip);
}

/** A roof tile: its outline and hachures down the fall line, closer for a steeper pitch. */
function roofTile(outline: Path2D, hatch: Path2D, p: Piece) {
  rect(outline, p);
  const gap = p.slope >= 60 ? 0.34 : p.slope >= 40 ? 0.5 : 0.67;
  const hw = p.w / 2;
  const hd = p.d / 2;
  for (let x = -hw + gap / 2; x < hw; x += gap) line(hatch, p, x, -hd, x, hd);
}

function addPiece(out: Paths, p: Piece) {
  out.empty = false;
  switch (p.kind) {
    case "floor":
      rect(out.floors, p);
      break;
    case "wall":
      line(bucket(out.walls, Math.round(p.d * 20) / 20), p, -p.w / 2, 0, p.w / 2, 0);
      break;
    case "door":
      door(out.doors, p);
      break;
    case "fence":
      line(out.fences, p, -p.w / 2, 0, p.w / 2, 0);
      break;
    case "beam":
      line(out.beams, p, -p.w / 2, 0, p.w / 2, 0);
      break;
    case "pole": {
      const path = bucket(out.poles, Math.round(Math.max(p.w, p.d) * 20) / 20);
      path.moveTo(p.x - 0.001, p.z);
      path.lineTo(p.x + 0.001, p.z);
      break;
    }
    case "stair":
      stair(out.stairs, p);
      break;
    case "roof":
      roofTile(out.roofs, out.hatch, p);
      break;
    case "other":
      // An unknown piece: only a small mark where it stands.
      out.dots.moveTo(p.x - 0.001, p.z);
      out.dots.lineTo(p.x + 0.001, p.z);
      break;
    default: {
      let path = out.marks.get(p.kind);
      if (!path) out.marks.set(p.kind, (path = new Path2D()));
      if (p.kind === "plant") {
        path.moveTo(p.x + Math.min(p.w, p.d) / 2, p.z);
        path.arc(p.x, p.z, Math.min(p.w, p.d) / 2, 0, Math.PI * 2);
      } else rect(path, p);
      if (p.kind === "light") {
        const r = Math.min(p.w, p.d) * 0.28;
        path.moveTo(p.x + r, p.z);
        path.arc(p.x, p.z, r, 0, Math.PI * 2);
      }
    }
  }
}

/**
 * The plans of every loaded base: bases and storeys found once per data
 * set, the paths of a storey built the first time it is drawn.
 */
export class FloorPlan {
  readonly bases: Base[];
  private storeyPaths = new Map<string, Paths[]>();

  constructor(private readonly pieces: readonly Piece[]) {
    this.bases = typeof Path2D === "undefined" ? [] : groupBases(pieces);
  }

  private paths(b: Base): Paths[] {
    let list = this.storeyPaths.get(b.key);
    if (!list) {
      // One per storey, and the roofs last.
      list = Array.from({ length: b.levels.length + 1 }, newPaths);
      for (const i of b.members) {
        const p = this.pieces[i]!;
        addPiece(list[pieceStorey(b.levels, p)]!, p);
      }
      this.storeyPaths.set(b.key, list);
    }
    return list;
  }

  /** The base and storey a point (a chest) is on, or null outside every base. */
  storeyAt(x: number, z: number, y: number | undefined): StoreyPick | null {
    const b = baseAt(this.bases, x, z);
    if (!b) return null;
    return { base: b.key, level: y === undefined ? 0 : storeyOf(b.levels, y) };
  }

  /** The base the floor switcher is for, seen in `box`. */
  active(box: readonly [number, number, number, number]): StoreyInfo | null {
    const b = activeBase(this.bases, box);
    return b ? { base: b.key, storeys: b.levels.length, hasRoof: b.hasRoof } : null;
  }

  /**
   * Draws the bases inside `box` under a world transform (x right, z up) for
   * view scale `scale`. The picked base shows its picked storey, the one
   * under it as a ghost, and nothing above; every other base its ground.
   */
  draw(g: CanvasRenderingContext2D, box: readonly [number, number, number, number], scale: number, alpha: number, pick: StoreyPick | null, active: string | null) {
    const px = 1 / scale;
    for (const b of this.bases) {
      const [x0, z0, x1, z1] = b.box;
      if (x1 < box[0] || x0 > box[2] || z1 < box[1] || z0 > box[3]) continue;
      const list = this.paths(b);
      const level = pick && pick.base === b.key ? Math.min(pick.level, list.length - 1) : 0;
      if (level > 0) {
        g.globalAlpha = alpha * 0.22;
        this.drawStorey(g, list[level - 1]!, px, scale, true);
      }
      g.globalAlpha = alpha;
      this.drawStorey(g, list[level]!, px, scale, false);
      if (b.key === active && b.levels.length > 1) {
        // The base the floor switcher is for: corner marks, as on a drawing sheet.
        g.globalAlpha = alpha;
        g.strokeStyle = ACTIVE;
        g.lineWidth = 1.6 * px;
        g.lineCap = "round";
        const m = 2 + 6 * px;
        const arm = Math.min(14 * px + 2, (x1 - x0) / 3, (z1 - z0) / 3);
        g.beginPath();
        for (const [cx, cz, dx, dz] of [
          [x0 - m, z0 - m, 1, 1],
          [x1 + m, z0 - m, -1, 1],
          [x1 + m, z1 + m, -1, -1],
          [x0 - m, z1 + m, 1, -1],
        ] as const) {
          g.moveTo(cx + dx * arm, cz);
          g.lineTo(cx, cz);
          g.lineTo(cx, cz + dz * arm);
        }
        g.stroke();
        g.lineCap = "butt";
      }
    }
    g.globalAlpha = 1;
  }

  private drawStorey(g: CanvasRenderingContext2D, s: Paths, px: number, scale: number, ghost: boolean) {
    if (s.empty) return;
    g.lineJoin = "miter";
    g.lineCap = "butt";
    // Floors: light plates with a hairline, so the grid of boards reads.
    g.fillStyle = FLOOR;
    g.fill(s.floors);
    g.strokeStyle = FLOOR_LINE;
    g.lineWidth = 0.7 * px;
    g.stroke(s.floors);
    if (!ghost) {
      for (const [kind, path] of s.marks) {
        const [fill, ink] = TINT[kind] ?? ["rgba(80, 60, 40, 0.2)", INK];
        g.fillStyle = fill;
        g.fill(path);
        g.strokeStyle = ink;
        g.lineWidth = 0.9 * px;
        g.stroke(path);
      }
      g.strokeStyle = INK;
      g.lineWidth = 0.8 * px;
      g.stroke(s.stairs);
    }
    // Roofs: a thin wash, hachures down the slope, the tiles' edges.
    g.fillStyle = ROOF_FILL;
    g.fill(s.roofs);
    g.strokeStyle = ROOF_INK;
    g.lineWidth = 0.6 * px;
    g.stroke(s.hatch);
    g.strokeStyle = ROOF_EDGE;
    g.lineWidth = 0.7 * px;
    g.stroke(s.roofs);
    // Walls: thick ink along their length, never thinner than a couple of pixels.
    g.strokeStyle = INK;
    g.lineCap = "square";
    const min = (1.3 + 0.3 * scale) * px;
    for (const [d, path] of s.walls) {
      g.lineWidth = Math.max(min, d);
      g.stroke(path);
    }
    g.lineCap = "butt";
    g.lineWidth = 1 * px;
    g.stroke(s.doors);
    g.lineWidth = 1.2 * px;
    g.stroke(s.beams);
    g.setLineDash([3.5 * px, 2.5 * px]);
    g.lineWidth = 1.6 * px;
    g.stroke(s.fences);
    g.setLineDash([]);
    g.lineCap = "square";
    g.fillStyle = INK;
    for (const [d, path] of s.poles) {
      g.lineWidth = Math.max(2.6 * px, d);
      g.stroke(path);
    }
    if (!ghost) {
      g.lineCap = "round";
      g.strokeStyle = "rgba(58, 42, 26, 0.7)";
      g.lineWidth = 3 * px;
      g.stroke(s.dots);
    }
    g.lineCap = "butt";
  }
}

/** How strongly floor plans show at this scale. */
export function planAlpha(scale: number): number {
  const t = Math.min(1, Math.max(0, (scale - PLAN_MIN_SCALE) / (PLAN_FULL_SCALE - PLAN_MIN_SCALE)));
  return t * t * (3 - 2 * t);
}

/** The world box of a view, padded by `pad` metres. */
export function viewBox(v: View, pad = 0): [number, number, number, number] {
  const hw = v.w / 2 / v.scale + pad;
  const hh = v.h / 2 / v.scale + pad;
  return [v.cx - hw, v.cz - hh, v.cx + hw, v.cz + hh];
}
