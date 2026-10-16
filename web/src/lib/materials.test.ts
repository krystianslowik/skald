import { describe, expect, it } from "vitest";
import { averageTone, MATERIAL_ITEMS, mix, pieceMaterial } from "./materials";
import { tonePalette } from "./planrender";

describe("building materials", () => {
  it("reads a piece's material from its prefab name", () => {
    expect(pieceMaterial("wood_floor")).toBe("wood");
    expect(pieceMaterial("woodwall")).toBe("wood");
    expect(pieceMaterial("stake_wall")).toBe("wood");
    expect(pieceMaterial("wood_roof_45")).toBe("wood");
    // Core wood before the plain wood rule.
    expect(pieceMaterial("wood_wall_log")).toBe("corewood");
    expect(pieceMaterial("wood_pole_log_4")).toBe("corewood");
    expect(pieceMaterial("wood_log_45")).toBe("corewood");
    // Wood and iron beams are iron, not wood.
    expect(pieceMaterial("woodiron_beam")).toBe("iron");
    expect(pieceMaterial("iron_floor_2x2")).toBe("iron");
    expect(pieceMaterial("stone_floor_2x2")).toBe("stone");
    expect(pieceMaterial("blackmarble_tile_floor_2x2")).toBe("blackmarble");
    expect(pieceMaterial("Piece_grausten_floor_2x2")).toBe("grausten");
    expect(pieceMaterial("piece_grausten_roof_45")).toBe("grausten");
    expect(pieceMaterial("ashwood_wall_2x2")).toBe("ashwood");
  });

  it("leaves materials without a fitting item, and furniture, to the fixed colours", () => {
    for (const n of ["darkwood_roof", "stave_wall_2x2", "turf_roof", "piece_chest_wood", "piece_workbench", "#12345"]) expect(pieceMaterial(n)).toBeNull();
    expect(Object.keys(MATERIAL_ITEMS)).toHaveLength(7);
  });

  it("averages an icon's solid pixels, weighted by opacity", () => {
    // Two solid pixels, a soft edge and a transparent one.
    const px = [100, 50, 0, 255, 200, 150, 100, 255, 0, 0, 255, 100, 9, 9, 9, 0];
    expect(averageTone(px)).toEqual([150, 100, 50]);
    expect(averageTone([10, 10, 10, 0, 20, 20, 20, 60])).toBeNull();
    expect(averageTone([])).toBeNull();
  });

  it("mixes colours", () => {
    expect(mix([0, 100, 200], [100, 100, 0], 0.5)).toEqual([50, 100, 100]);
    expect(mix([10, 20, 30], [90, 90, 90], 0)).toEqual([10, 20, 30]);
  });

  it("keeps floors light and walls dark whatever the tone", () => {
    const pal = tonePalette([132, 130, 124]);
    const rgb = (s: string) => s.match(/\d+/g)!.slice(0, 3).map(Number);
    const lum = (c: number[]) => 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]!;
    expect(lum(rgb(pal.floor))).toBeGreaterThan(160);
    expect(lum(rgb(pal.wall))).toBeLessThan(90);
  });
});
