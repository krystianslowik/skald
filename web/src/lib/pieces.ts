// Floor plans: what players built, from GET /api/pieces. The compact answer
// is decoded once into plain pieces; pieces are grouped into bases by how
// close they stand, and each base into storeys by the height of its floors.
// Everything here is pure, so it is tested without a canvas.

import type { ApiPieces, PieceKind } from "../types";

export interface Piece {
  name: string;
  kind: PieceKind;
  x: number;
  z: number;
  y: number;
  /** Degrees clockwise seen from above. */
  yaw: number;
  /** Footprint in metres along the piece's local x and z. */
  w: number;
  d: number;
  /** A roof's pitch in degrees, else 0. */
  slope: number;
  known: boolean;
  tilted: boolean;
}

const KINDS = new Set<PieceKind>(["wall", "floor", "roof", "door", "stair", "beam", "pole", "fence", "station", "furniture", "storage", "light", "portal", "plant", "other"]);

/** The answer's pieces, or null when it is not a floor plan (an older server, a proxy page). */
export function decodePieces(body: unknown): Piece[] | null {
  const b = body as Partial<ApiPieces> | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.prefabs) || !Array.isArray(b.pieces)) return null;
  const out: Piece[] = [];
  for (const row of b.pieces) {
    if (!Array.isArray(row)) continue;
    const pf = b.prefabs[row[0]];
    if (!Array.isArray(pf)) continue;
    const [name, kind, w, d, slope, known] = pf;
    const [, x, z, y, yaw, flags] = row;
    if (![x, z, y, yaw, w, d].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    out.push({ name: String(name), kind: KINDS.has(kind) ? kind : "other", x, z, y, yaw, w: Math.max(0.05, w), d: Math.max(0.05, d), slope: slope || 0, known: known !== false, tilted: (Number(flags) & 1) === 1 });
  }
  return out;
}

// ---- geometry ----------------------------------------------------------------

/**
 * A piece's local axes in world x, z: local +x points along
 * (cos yaw, -sin yaw), local +z along (sin yaw, cos yaw). On the north-up map
 * (screen y = -z) that turns clockwise with the yaw, as in the game.
 */
export function pieceAxes(yaw: number): { ux: [number, number]; uz: [number, number] } {
  const r = (yaw * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { ux: [c, -s], uz: [s, c] };
}

/** A point given in the piece's own frame (metres from its centre), in world x, z. */
export function pieceLocal(p: Pick<Piece, "x" | "z" | "yaw">, lx: number, lz: number): [number, number] {
  const { ux, uz } = pieceAxes(p.yaw);
  return [p.x + ux[0] * lx + uz[0] * lz, p.z + ux[1] * lx + uz[1] * lz];
}

/** The footprint's corners in world x, z, going round: (-w/2, -d/2), (w/2, -d/2), (w/2, d/2), (-w/2, d/2). */
export function pieceCorners(p: Pick<Piece, "x" | "z" | "yaw" | "w" | "d">): [number, number][] {
  const hw = p.w / 2;
  const hd = p.d / 2;
  return [pieceLocal(p, -hw, -hd), pieceLocal(p, hw, -hd), pieceLocal(p, hw, hd), pieceLocal(p, -hw, hd)];
}

/** Which way a roof or a stair climbs, in world x, z: its local -z. */
export function uphill(yaw: number): [number, number] {
  const { uz } = pieceAxes(yaw);
  return [-uz[0], -uz[1]];
}

// ---- fetching in chunks --------------------------------------------------------

/** Floor plans are fetched in aligned squares this many metres a side. */
export const CHUNK = 512;

export type ChunkKey = string;

/** The aligned chunks a box touches. */
export function chunksFor(box: readonly [number, number, number, number]): ChunkKey[] {
  const [x0, z0, x1, z1] = box;
  const out: ChunkKey[] = [];
  for (let i = Math.floor(x0 / CHUNK); i <= Math.floor(x1 / CHUNK); i++) {
    for (let j = Math.floor(z0 / CHUNK); j <= Math.floor(z1 / CHUNK); j++) out.push(`${i},${j}`);
  }
  return out;
}

/** A chunk's world box. */
export function chunkBox(key: ChunkKey): [number, number, number, number] {
  const [i, j] = key.split(",").map(Number) as [number, number];
  return [i * CHUNK, j * CHUNK, (i + 1) * CHUNK, (j + 1) * CHUNK];
}

/** A box cut into four, for an answer that came back truncated. */
export function quarters(box: readonly [number, number, number, number]): [number, number, number, number][] {
  const [x0, z0, x1, z1] = box;
  const mx = (x0 + x1) / 2;
  const mz = (z0 + z1) / 2;
  return [
    [x0, z0, mx, mz],
    [mx, z0, x1, mz],
    [x0, mz, mx, z1],
    [mx, mz, x1, z1],
  ];
}

/** Whether a piece belongs to a box: its centre inside, the far edges open, so neighbouring boxes never share one. */
export function inBox(x: number, z: number, box: readonly [number, number, number, number]): boolean {
  return x >= box[0] && x < box[2] && z >= box[1] && z < box[3];
}

// ---- bases and storeys -----------------------------------------------------------

/** Pieces closer than about this (one grid cell and its neighbours) belong to one base. */
export const LINK = 3;
/** Floors whose heights differ by less than this step are one storey (uneven ground, slopes). */
export const STOREY_GAP = 1.2;
/** A storey needs this many floor pieces; a ledge or a lone platform is not one. */
export const STOREY_MIN_FLOORS = 2;
/** A piece this little below a storey's floor still stands on it. */
export const STOREY_EPS = 0.3;
/** A lower storey with at least this share of the largest one's floor area is still the main one. */
export const MAIN_SHARE = 0.6;

export interface Base {
  /** Stable while the base stays as built: its rounded centre. */
  key: string;
  box: [number, number, number, number];
  cx: number;
  cz: number;
  /** Floor height of each storey, ground first. One entry for a single storey. */
  levels: number[];
  /** The storey the floor switcher opens on: where most of the floor is (see `mainStorey`). */
  main: number;
  hasRoof: boolean;
  /** Indexes into the pieces given to `groupBases`. */
  members: number[];
}

/** Floor heights of the storeys, from the heights of a base's floor pieces. */
export function storeyLevels(floorYs: readonly number[]): number[] {
  const ys = [...floorYs].sort((a, b) => a - b);
  const levels: number[] = [];
  let start = 0;
  for (let i = 1; i <= ys.length; i++) {
    // A storey runs while each floor is within a step of the last one: a slope climbs in small steps.
    if (i < ys.length && ys[i]! - ys[i - 1]! <= STOREY_GAP) continue;
    if (i - start >= STOREY_MIN_FLOORS) levels.push(ys[start]!);
    start = i;
  }
  return levels.length ? levels : ys.length ? [ys[0]!] : [0];
}

/** The storey a height belongs to: the highest whose floor is at or below it. Below the ground floor is the ground. */
export function storeyOf(levels: readonly number[], y: number): number {
  let level = 0;
  for (let i = 1; i < levels.length; i++) if (levels[i]! <= y + STOREY_EPS) level = i;
  return level;
}

/**
 * The main storey of a base from each storey's floor area: the largest one,
 * unless a storey below has nearly as much (a plain two-storey house opens on
 * its ground floor). A yard, a jetty or a terrace of floor pieces a step under
 * the house has far less floor than the house, so it is kept as its own level
 * but never preselected.
 */
export function mainStorey(areas: readonly number[]): number {
  const most = Math.max(0, ...areas);
  const i = areas.findIndex((a) => a >= most * MAIN_SHARE);
  return Math.max(0, i);
}

/** A piece's storey in its base; roofs are on their own level, one past the top storey. */
export function pieceStorey(levels: readonly number[], p: Pick<Piece, "kind" | "y">): number {
  return p.kind === "roof" ? levels.length : storeyOf(levels, p.y);
}

/**
 * Pieces grouped into bases: cells of LINK metres, each joined to its
 * neighbours, so walls a couple of metres apart hold a house together and
 * houses a dozen metres apart stay apart.
 */
export function groupBases(pieces: readonly Piece[]): Base[] {
  const cells = new Map<string, number>();
  const parent: number[] = [];
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const cellOf: number[] = [];
  for (const p of pieces) {
    const k = `${Math.floor(p.x / LINK)},${Math.floor(p.z / LINK)}`;
    let c = cells.get(k);
    if (c === undefined) {
      c = parent.length;
      parent.push(c);
      cells.set(k, c);
    }
    cellOf.push(c);
  }
  for (const [k, c] of cells) {
    const [i, j] = k.split(",").map(Number) as [number, number];
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const n = cells.get(`${i + di},${j + dj}`);
        if (n !== undefined) union(c, n);
      }
    }
  }
  const by = new Map<number, number[]>();
  for (const [i, c] of cellOf.entries()) {
    const r = find(c);
    const list = by.get(r);
    if (list) list.push(i);
    else by.set(r, [i]);
  }
  const out: Base[] = [];
  for (const members of by.values()) {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    const floorYs: number[] = [];
    const floors: Piece[] = [];
    let hasRoof = false;
    for (const i of members) {
      const p = pieces[i]!;
      const r = Math.max(p.w, p.d) / 2;
      x0 = Math.min(x0, p.x - r);
      z0 = Math.min(z0, p.z - r);
      x1 = Math.max(x1, p.x + r);
      z1 = Math.max(z1, p.z + r);
      if (p.kind === "floor") {
        floorYs.push(p.y);
        floors.push(p);
      } else if (p.kind === "roof") hasRoof = true;
    }
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const levels = storeyLevels(floorYs);
    const areas = levels.map(() => 0);
    for (const p of floors) areas[storeyOf(levels, p.y)]! += p.w * p.d;
    out.push({ key: `${Math.round(cx)},${Math.round(cz)}`, box: [x0, z0, x1, z1], cx, cz, levels, main: mainStorey(areas), hasRoof, members });
  }
  return out;
}

/** The base a point lies in (its box, with a little margin), the smallest one when boxes overlap. */
export function baseAt(bases: readonly Base[], x: number, z: number, margin = 1): Base | null {
  let best: Base | null = null;
  let area = Infinity;
  for (const b of bases) {
    const [x0, z0, x1, z1] = b.box;
    if (x < x0 - margin || x > x1 + margin || z < z0 - margin || z > z1 + margin) continue;
    const a = (x1 - x0) * (z1 - z0);
    if (a < area) {
      best = b;
      area = a;
    }
  }
  return best;
}

/**
 * Which base the floor switcher is for: of the bases with more than one
 * storey that the view shows, the one nearest the view's centre.
 */
export function activeBase(bases: readonly Base[], view: readonly [number, number, number, number]): Base | null {
  const [vx0, vz0, vx1, vz1] = view;
  const cx = (vx0 + vx1) / 2;
  const cz = (vz0 + vz1) / 2;
  let best: Base | null = null;
  let bestD = Infinity;
  for (const b of bases) {
    if (b.levels.length < 2) continue;
    const [x0, z0, x1, z1] = b.box;
    if (x1 < vx0 || x0 > vx1 || z1 < vz0 || z0 > vz1) continue;
    // Distance from the centre to the base's box: zero when the centre is inside.
    const d = Math.hypot(Math.max(x0 - cx, 0, cx - x1), Math.max(z0 - cz, 0, cz - z1));
    if (d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}
