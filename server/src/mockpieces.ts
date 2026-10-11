import type { ApiPieces, MapContainer, PieceKind, PiecePrefab, PieceRow } from "./types";

/**
 * Made-up floor plans for MOCK_AGENT=1, the tests and the screenshots: the
 * home base as a two-storey longhouse with a roof, a sleeping house, a
 * workshop and a palisade; a swamp hut on sloping ground; a stone hut in the
 * mountains. Chests come from the mock map's own containers, so stacks line
 * up with the stores. Nothing here comes from a real save.
 */

/** The prefabs the mock uses, sized like the agent's table. */
const PREFABS: Record<string, [PieceKind, number, number, number]> = {
  wood_floor: ["floor", 2, 2, 0],
  stone_floor_2x2: ["floor", 2, 2, 0],
  woodwall: ["wall", 2, 0.25, 0],
  wood_wall_half: ["wall", 2, 0.25, 0],
  stone_wall_2x1: ["wall", 2, 1, 0],
  wood_window: ["wall", 1, 0.25, 0],
  wood_door: ["door", 2, 0.25, 0],
  wood_gate: ["door", 4, 0.25, 0],
  wood_roof: ["roof", 2, 2, 26],
  wood_roof_top: ["roof", 2, 2, 26],
  wood_roof_45: ["roof", 2, 2, 45],
  wood_roof_top_45: ["roof", 2, 2, 45],
  wood_stair: ["stair", 2, 2, 0],
  wood_beam: ["beam", 2, 0.25, 0],
  wood_pole2: ["pole", 0.25, 0.25, 0],
  wood_pole_log: ["pole", 0.5, 0.5, 0],
  stake_wall: ["fence", 2, 0.5, 0],
  wood_fence: ["fence", 2, 0.2, 0],
  piece_workbench: ["station", 2, 1, 0],
  piece_workbench_ext1: ["station", 1, 0.5, 0],
  forge: ["station", 2, 1.5, 0],
  forge_ext1: ["station", 1, 1, 0],
  piece_cauldron: ["station", 1.5, 1.5, 0],
  guard_stone: ["station", 1, 1, 0],
  piece_chest_wood: ["storage", 0.6, 0.9, 0],
  piece_chest: ["storage", 0.9, 1.5, 0],
  piece_chest_private: ["storage", 0.6, 0.9, 0],
  piece_chest_barrel: ["storage", 1, 1, 0],
  wood_stack: ["storage", 2, 1, 0],
  bed: ["furniture", 1, 2, 0],
  piece_table: ["furniture", 2, 1, 0],
  piece_bench01: ["furniture", 2, 0.5, 0],
  rug_deer: ["furniture", 2, 1.5, 0],
  fire_pit: ["light", 2, 2, 0],
  hearth: ["light", 3, 2, 0],
  piece_groundtorch_wood: ["light", 0.5, 0.5, 0],
  portal_wood: ["portal", 3, 1, 0],
  sapling_carrot: ["plant", 0.5, 0.5, 0],
};

type Piece = [name: string, x: number, z: number, y: number, yaw: number];

/** Floors on a 2 m grid filling [x0, x1] x [z0, z1]; `rise` tilts the ground (metres per metre of z). */
function floors(out: Piece[], x0: number, z0: number, x1: number, z1: number, y: number, name = "wood_floor", rise = 0) {
  for (let x = x0 + 1; x < x1; x += 2) for (let z = z0 + 1; z < z1; z += 2) out.push([name, x, z, +(y + (z - z0) * rise).toFixed(2), 0]);
}

/**
 * Walls round a rectangle in 2 m pieces, `y` the walls' centre. `doors` are
 * the wall centres (x for the south and north sides, z for west and east)
 * that get a door instead.
 */
function walls(out: Piece[], x0: number, z0: number, x1: number, z1: number, y: number, name = "woodwall", doors: { side: "s" | "n" | "w" | "e"; at: number }[] = [], rise = 0) {
  const door = (side: string, at: number) => doors.some((d) => d.side === side && d.at === at);
  for (let x = x0 + 1; x < x1; x += 2) {
    out.push([door("s", x) ? "wood_door" : name, x, z0, y, 0]);
    out.push([door("n", x) ? "wood_door" : name, x, z1, +(y + (z1 - z0) * rise).toFixed(2), 180]);
  }
  for (let z = z0 + 1; z < z1; z += 2) {
    const yz = +(y + (z - z0) * rise).toFixed(2);
    out.push([door("w", z) ? "wood_door" : name, x0, z, yz, 90]);
    out.push([door("e", z) ? "wood_door" : name, x1, z, yz, 270]);
  }
}

/**
 * A gable roof over [x0, x1] x [z0, z1], ridge along x, 1 m of eaves. Each
 * tile climbs towards its local -z: yaw 180 on the south slope (uphill is
 * +z), 0 on the north.
 */
function roof(out: Piece[], x0: number, z0: number, x1: number, z1: number, eaves: number, steep = false) {
  const tile = steep ? "wood_roof_45" : "wood_roof";
  const top = steep ? "wood_roof_top_45" : "wood_roof_top";
  const rise = steep ? 2 : 1;
  const ridge = (z0 + z1) / 2;
  for (let x = x0; x <= x1; x += 2) {
    let row = 0;
    for (let z = z0; z < ridge - 1; z += 2, row++) out.push([tile, x, z, eaves + rise * (row + 0.5), 180]);
    row = 0;
    for (let z = z1; z > ridge + 1; z -= 2, row++) out.push([tile, x, z, eaves + rise * (row + 0.5), 0]);
    out.push([top, x, ridge, eaves + rise * ((ridge - z0) / 2), 0]);
  }
}

/** A palisade of stakes round a rectangle, with a gate on the north side at `gate`. */
function palisade(out: Piece[], x0: number, z0: number, x1: number, z1: number, y: number, gate: number) {
  for (let x = x0 + 1; x < x1; x += 2) {
    out.push(["stake_wall", x, z0, y, 0]);
    if (Math.abs(x - gate) > 2) out.push(["stake_wall", x, z1, y, 0]);
  }
  out.push(["wood_gate", gate, z1, y, 0]);
  for (let z = z0 + 1; z < z1; z += 2) {
    out.push(["stake_wall", x0, z, y, 90]);
    out.push(["stake_wall", x1, z, y, 90]);
  }
}

/** Ground level (floor tops) of each mock base. */
export const MOCK_GROUND = { home: 31.65, upper: 34.65, swamp: 30.4, mountain: 58.2 };

function homeBase(out: Piece[]) {
  const g = MOCK_GROUND.home;
  const up = MOCK_GROUND.upper;
  // The longhouse: a hall the full length on the ground, a loft over its
  // east half reached by three flights of stairs, one long roof over both.
  floors(out, 204, -356, 236, -344, g);
  walls(out, 204, -356, 236, -344, g + 1, "woodwall", [{ side: "n", at: 213 }, { side: "w", at: -351 }]);
  walls(out, 204, -356, 236, -344, g + 2.5, "wood_wall_half");
  floors(out, 220, -356, 236, -344, up);
  walls(out, 220, -356, 236, -344, up + 1, "woodwall", [{ side: "w", at: -345 }]);
  for (const [i, x] of [215, 217, 219].entries()) out.push(["wood_stair", x, -345, g + 0.5 + i, 270]);
  roof(out, 204, -357, 236, -343, up + 2);
  for (let x = 206; x < 236; x += 6) out.push(["wood_pole_log", x, -350, g + 1.5, 0]);
  out.push(["hearth", 217, -351, g + 0.1, 0], ["bed", 232, -350, g + 0.05, 90], ["portal_wood", 210, -350, g + 0.05, 90]);
  out.push(["piece_table", 228, -350, up + 0.4, 0], ["piece_bench01", 228, -351.2, up + 0.25, 0], ["rug_deer", 232, -350, up + 0.02, 90]);
  out.push(["wood_window", 224, -356, up + 1.2, 0], ["wood_window", 232, -344, up + 1.2, 180]);

  // The sleeping house across the yard.
  floors(out, 210, -336, 232, -326, g);
  walls(out, 210, -336, 232, -326, g + 1, "woodwall", [{ side: "s", at: 221 }]);
  roof(out, 209, -337, 233, -325, g + 2, true);
  out.push(["fire_pit", 221, -331, g + 0.05, 0], ["bed", 228, -332, g + 0.05, 0], ["bed", 214, -330, g + 0.05, 0]);

  // The workshop: a roof on poles, the workbench and forge with their tools.
  floors(out, 238, -352, 250, -342, g - 0.05, "stone_floor_2x2");
  for (const [x, z] of [[238, -352], [244, -352], [250, -352], [238, -342], [244, -342], [250, -342]] as const) out.push(["wood_pole2", x, z, g + 1, 0]);
  for (const z of [-352, -342]) for (let x = 239; x < 250; x += 2) out.push(["wood_beam", x, z, g + 2, 0]);
  roof(out, 238, -353, 250, -341, g + 2);
  out.push(["piece_workbench", 241.5, -350.6, g + 0.05, 0], ["piece_workbench_ext1", 243.2, -350.8, g + 0.05, 0]);
  out.push(["forge", 247, -350.4, g + 0.05, 0], ["forge_ext1", 249, -350.6, g + 0.05, 0]);
  out.push(["piece_cauldron", 240, -344.5, g + 0.05, 0], ["wood_stack", 246, -343, g + 0.05, 0], ["wood_stack", 248.2, -343, g + 0.05, 0]);

  // The yard: torches at the doors, the ward, a carrot patch, the palisade.
  out.push(["fire_pit", 226, -340, g, 0], ["guard_stone", 216, -340, g, 0], ["portal_wood", 236, -322, g, 0], ["portal_wood", 252, -360, g, 0]);
  out.push(["piece_groundtorch_wood", 211.5, -342.6, g, 0], ["piece_groundtorch_wood", 214.5, -342.6, g, 0], ["piece_groundtorch_wood", 223, -337.5, g, 0]);
  for (let x = 240; x <= 250; x += 1.25) for (let z = -332; z <= -326; z += 1.5) out.push(["sapling_carrot", x, z, g - 0.1, 0]);
  for (let x = 239; x < 251; x += 2) {
    out.push(["wood_fence", x, -333, g, 0], ["wood_fence", x, -325, g, 0]);
  }
  palisade(out, 198, -366, 256, -316, g + 1, 225);
}

function swampBase(out: Piece[]) {
  // A hut on sloping ground: the floors climb 0.15 m per metre northwards.
  const g = MOCK_GROUND.swamp;
  const rise = 0.06;
  floors(out, -1470, 970, -1450, 994, g, "wood_floor", rise);
  walls(out, -1470, 970, -1450, 994, g + 1, "woodwall", [{ side: "s", at: -1459 }], rise);
  roof(out, -1471, 969, -1449, 995, g + 2 + 12 * rise, true);
  out.push(["fire_pit", -1460, 982, g + 12 * rise, 0], ["piece_workbench", -1456, 975.6, g + 5.6 * rise, 0], ["bed", -1468, 972, g + 2 * rise, 90]);
  out.push(["portal_wood", -1450, 1000, g + 1.6, 90]);
}

function mountainBase(out: Piece[]) {
  const g = MOCK_GROUND.mountain;
  floors(out, 1570, 1716, 1582, 1728, g, "stone_floor_2x2");
  walls(out, 1570, 1716, 1582, 1728, g + 0.5, "stone_wall_2x1", [{ side: "s", at: 1577 }]);
  walls(out, 1570, 1716, 1582, 1728, g + 1.5, "stone_wall_2x1", [{ side: "s", at: 1577 }]);
  roof(out, 1569, 1715, 1583, 1729, g + 2);
  out.push(["fire_pit", 1577, 1722, g, 0], ["piece_workbench", 1579, 1718.2, g, 0], ["portal_wood", 1570, 1700, g - 1.2, 0]);
}

/** Small deterministic offsets, so chests do not sit on exact metres as the containers do. */
function jitter(i: number): number {
  return (((i * 7919) % 11) - 5) / 50;
}

/**
 * A chest piece for every chest container, where it really stands: stacked
 * chests drift a little and alternate their heading, as people place them.
 */
function chests(out: Piece[], storage: readonly MapContainer[]) {
  const seen = new Map<string, number>();
  for (const [i, c] of storage.entries()) {
    if (c.kind !== "chest") continue;
    const spot = `${c.x},${c.z}`;
    const level = seen.get(spot) ?? 0;
    seen.set(spot, level + 1);
    const drift = [0, 0.35, -0.3][level % 3]!;
    out.push([c.prefab, +(c.x + jitter(i) + drift).toFixed(2), +(c.z + jitter(i + 3) + drift / 2).toFixed(2), c.y ?? 0, level % 2 ? 180 : 0]);
  }
}

/** Every mock piece, in the agent's compact form. */
export function mockPieces(storage: readonly MapContainer[]): { prefabs: PiecePrefab[]; pieces: PieceRow[] } {
  const all: Piece[] = [];
  homeBase(all);
  swampBase(all);
  mountainBase(all);
  chests(all, storage);
  const index = new Map<string, number>();
  const prefabs: PiecePrefab[] = [];
  const pieces: PieceRow[] = [];
  // Lowest first, as the agent sends them within a zone.
  all.sort((a, b) => a[3] - b[3]);
  for (const [name, x, z, y, yaw] of all) {
    let i = index.get(name);
    if (i === undefined) {
      const [kind, w, d, slope] = PREFABS[name] ?? ["other", 1, 1, 0];
      i = prefabs.push([name, kind, w, d, slope, name in PREFABS]) - 1;
      index.set(name, i);
    }
    pieces.push([i, x, z, y, ((yaw % 360) + 360) % 360, 0]);
  }
  return { prefabs, pieces };
}

/** The agent's answer for a box: pieces whose position lies inside it, prefabs renumbered. */
export function piecesIn(all: { prefabs: PiecePrefab[]; pieces: PieceRow[] }, box: readonly [number, number, number, number], generation: number, max = 20_000): ApiPieces {
  const [x0, z0, x1, z1] = box;
  const inside = all.pieces.filter((p) => p[1] >= x0 && p[1] <= x1 && p[2] >= z0 && p[2] <= z1);
  const keep = inside.slice(0, max);
  const index = new Map<number, number>();
  const prefabs: PiecePrefab[] = [];
  const pieces = keep.map((p): PieceRow => {
    let i = index.get(p[0]);
    if (i === undefined) {
      i = prefabs.push(all.prefabs[p[0]]!) - 1;
      index.set(p[0], i);
    }
    return [i, p[1], p[2], p[3], p[4], p[5]];
  });
  return { generation, bbox: [x0, z0, x1, z1], prefabs, pieces, count: pieces.length, truncated: inside.length > keep.length };
}
