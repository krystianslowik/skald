import { describe, expect, it } from "vitest";
import { mockMap } from "@server/mapmock";
import { mockPieces, piecesIn } from "@server/mockpieces";
import type { PieceKind } from "../types";
import { activeBase, baseAt, chunkBox, chunksFor, decodePieces, groupBases, inBox, mainStorey, pieceCorners, pieceLocal, pieceStorey, quarters, storeyLevels, storeyOf, uphill, type Piece } from "./pieces";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

function piece(kind: PieceKind, x: number, z: number, y: number, yaw = 0, w = 2, d = 2): Piece {
  return { name: kind, kind, x, z, y, yaw, w, d, slope: kind === "roof" ? 26 : 0, known: true, tilted: false };
}

/** A house: floors on a grid at `y`, a wall ring at `y + 1`. */
function house(x0: number, z0: number, nx: number, nz: number, y: number, out: Piece[] = []): Piece[] {
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) out.push(piece("floor", x0 + 1 + 2 * i, z0 + 1 + 2 * j, y));
  for (let i = 0; i < nx; i++) out.push(piece("wall", x0 + 1 + 2 * i, z0, y + 1, 0, 2, 0.25), piece("wall", x0 + 1 + 2 * i, z0 + 2 * nz, y + 1, 0, 2, 0.25));
  for (let j = 0; j < nz; j++) out.push(piece("wall", x0, z0 + 1 + 2 * j, y + 1, 90, 2, 0.25), piece("wall", x0 + 2 * nx, z0 + 1 + 2 * j, y + 1, 90, 2, 0.25));
  return out;
}

describe("piece geometry", () => {
  it("turns local +x clockwise seen from above", () => {
    // Yaw 0: local +x is world +x, local +z is north.
    close(pieceLocal({ x: 10, z: 20, yaw: 0 }, 1, 0), [11, 20]);
    close(pieceLocal({ x: 10, z: 20, yaw: 0 }, 0, 1), [10, 21]);
    // Yaw 90: local +x points south (world -z), local +z east.
    close(pieceLocal({ x: 10, z: 20, yaw: 90 }, 1, 0), [10, 19]);
    close(pieceLocal({ x: 10, z: 20, yaw: 90 }, 0, 1), [11, 20]);
  });

  it("puts a wall's long side along its local x", () => {
    const flat = pieceCorners({ x: 0, z: 0, yaw: 0, w: 2, d: 0.25 });
    close(flat.flat(), [-1, -0.125, 1, -0.125, 1, 0.125, -1, 0.125]);
    const turned = pieceCorners({ x: 0, z: 0, yaw: 90, w: 2, d: 0.25 });
    const xs = turned.map((c) => c[0]);
    const zs = turned.map((c) => c[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.25);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(2);
  });

  it("climbs towards local -z", () => {
    close(uphill(0), [0, -1]);
    close(uphill(180), [0, 1]);
    close(uphill(270), [1, 0]);
    close(uphill(90), [-1, 0]);
  });

  it("decodes the agent's answer and refuses anything else", () => {
    const got = decodePieces({ generation: 1, bbox: [0, 0, 1, 1], prefabs: [["wood_floor", "floor", 2, 2, 0, true], ["#1a2b", "other", 1, 1, 0, false]], pieces: [[0, 118, -200, 31.65, 270, 0], [1, 5, 6, 7, 0, 1]], count: 2, truncated: false });
    expect(got).toHaveLength(2);
    expect(got![0]).toMatchObject({ name: "wood_floor", kind: "floor", x: 118, z: -200, y: 31.65, yaw: 270, w: 2, d: 2, known: true, tilted: false });
    expect(got![1]).toMatchObject({ kind: "other", known: false, tilted: true });
    expect(decodePieces({ meta: {} })).toBeNull();
    expect(decodePieces(null)).toBeNull();
  });
});

describe("chunks", () => {
  it("covers a box with aligned chunks that never share a piece", () => {
    expect(chunksFor([10, 10, 20, 20])).toEqual(["0,0"]);
    expect(chunksFor([-10, 500, 520, 530]).sort()).toEqual(["-1,0", "-1,1", "0,0", "0,1", "1,0", "1,1"]);
    expect(chunkBox("-1,2")).toEqual([-512, 1024, 0, 1536]);
    // A piece on the line between two chunks belongs to one only.
    expect(inBox(512, 3, chunkBox("0,0"))).toBe(false);
    expect(inBox(512, 3, chunkBox("1,0"))).toBe(true);
    expect(quarters([0, 0, 512, 512])).toEqual([
      [0, 0, 256, 256],
      [256, 0, 512, 256],
      [0, 256, 256, 512],
      [256, 256, 512, 512],
    ]);
  });

  it("keeps the mock's pieces when cut into chunks and put back together", () => {
    const all = mockPieces(mockMap().storage!);
    const keys = chunksFor([150, -400, 300, -300]);
    let n = 0;
    for (const k of keys) n += decodePieces(piecesIn(all, chunkBox(k), 1))!.filter((p) => inBox(p.x, p.z, chunkBox(k))).length;
    expect(n).toBe(all.pieces.filter((p) => p[1] > 150 && p[1] < 300 && p[2] > -400 && p[2] < -300).length);
  });
});

describe("storeys", () => {
  it("finds two storeys in a two-storey house", () => {
    const ps = house(0, 0, 4, 3, 30);
    house(0, 0, 4, 3, 33, ps);
    const [b] = groupBases(ps);
    expect(b!.levels).toEqual([30, 33]);
    // Ground walls stand at y + 1 and stay on the ground; the upper walls go up.
    expect(storeyOf(b!.levels, 31)).toBe(0);
    expect(storeyOf(b!.levels, 34)).toBe(1);
    // A chest on the upper floor, a hair below its pivot.
    expect(storeyOf(b!.levels, 32.8)).toBe(1);
  });

  it("keeps a house on a slope one storey", () => {
    const ps: Piece[] = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 10; j++) ps.push(piece("floor", 1 + 2 * i, 1 + 2 * j, 30 + j * 0.4));
    const [b] = groupBases(ps);
    expect(b!.levels).toHaveLength(1);
  });

  it("finds three floors in a tower and puts roofs on their own level", () => {
    const ps: Piece[] = [];
    for (const y of [50, 53, 56]) house(0, 0, 2, 2, y, ps);
    ps.push(piece("roof", 2, 2, 59.5, 180));
    const bases = groupBases(ps);
    expect(bases).toHaveLength(1);
    const b = bases[0]!;
    expect(b.levels).toEqual([50, 53, 56]);
    expect(b.hasRoof).toBe(true);
    expect(pieceStorey(b.levels, ps.at(-1)!)).toBe(3);
    expect(pieceStorey(b.levels, { kind: "wall", y: 57 })).toBe(2);
  });

  it("has one storey for a single-storey house, and a lone ledge is no storey", () => {
    const ps = house(0, 0, 3, 3, 20);
    ps.push(piece("floor", 3, 3, 24));
    const [b] = groupBases(ps);
    expect(b!.levels).toEqual([20]);
    expect(storeyLevels([])).toEqual([0]);
  });

  it("tells houses apart and finds the one at the view's centre", () => {
    const ps = house(0, 0, 3, 3, 10);
    house(0, 0, 3, 3, 13, ps);
    house(40, 0, 3, 3, 10, ps);
    house(40, 0, 3, 3, 13, ps);
    house(100, 0, 2, 2, 10, ps);
    const bases = groupBases(ps);
    expect(bases).toHaveLength(3);
    expect(activeBase(bases, [30, -20, 60, 20])?.cx).toBeCloseTo(43);
    expect(activeBase(bases, [-10, -20, 20, 20])?.cx).toBeCloseTo(3);
    // The single-storey one never gets a switcher.
    expect(activeBase(bases, [95, -5, 110, 10])).toBeNull();
    expect(baseAt(bases, 44, 3)?.cx).toBeCloseTo(43);
    expect(baseAt(bases, 70, 3)).toBeNull();
  });

  it("finds the mock longhouse's loft", () => {
    const all = decodePieces(piecesIn(mockPieces(mockMap().storage!), [192, -384, 256, -320], 1))!;
    const hall = baseAt(groupBases(all), 225, -350)!;
    expect(hall.levels).toHaveLength(2);
    expect(hall.hasRoof).toBe(true);
    // The hall below is larger than the loft: the switcher opens on the ground.
    expect(hall.main).toBe(0);
  });
});

describe("main storey", () => {
  it("opens a plain two-storey house on its ground floor", () => {
    const ps = house(0, 0, 4, 3, 30);
    house(0, 0, 4, 3, 33, ps);
    expect(groupBases(ps)[0]!.main).toBe(0);
    // An upper floor a little wider than the ground (an overhang) does not win either.
    ps.push(piece("floor", 9, 1, 33), piece("floor", 9, 3, 33));
    expect(groupBases(ps)[0]!.main).toBe(0);
  });

  it("skips a yard of floor pieces at the ground and opens on the house above", () => {
    // A strip of yard (or a jetty) two metres under the house's floor.
    const ps: Piece[] = [];
    for (let i = 0; i < 4; i++) ps.push(piece("floor", 1 + 2 * i, -1, 30));
    house(0, 0, 4, 3, 32, ps);
    const [b] = groupBases(ps);
    expect(b!.levels).toEqual([30, 32]);
    expect(b!.main).toBe(1);
  });

  it("weighs footprints, prefers the lower of near equals, and copes with nothing", () => {
    expect(mainStorey([4, 12])).toBe(1);
    expect(mainStorey([10, 12, 2])).toBe(0);
    expect(mainStorey([2, 3, 12])).toBe(2);
    expect(mainStorey([])).toBe(0);
    expect(mainStorey([0])).toBe(0);
  });
});
