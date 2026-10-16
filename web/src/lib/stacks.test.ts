import { describe, expect, it } from "vitest";
import { mockMap } from "@server/mapmock";
import type { MapContainer } from "../types";
import { groupStacks, stackIndex, topDown } from "./stacks";

const chest = (id: string, x: number, z: number, y?: number, kind: MapContainer["kind"] = "chest"): MapContainer => ({ id, kind, prefab: "piece_chest_wood", x, z, y, width: 5, height: 2, items: [] });

describe("groupStacks", () => {
  it("stacks chests that drift and turn, bottom to top, whatever their ids", () => {
    // Placed by hand: each one a little off the one below (as the pieces give them).
    const stacks = groupStacks([chest("c", 10.3, 4.1, 33.5), chest("a", 10.1, 4.2, 31.7), chest("b", 10.4, 3.9, 32.6)]);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.chests.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(stacks[0]!.ordered).toBe(true);
  });

  it("stacks the agent's chests on one metre, and never merges rows 0.85 m apart", () => {
    const stacks = groupStacks([chest("x@1,1", 1, 1, 30.9), chest("x@1,1#1", 1, 1, 31.8), chest("y@2,1", 2, 1, 30.9), chest("p", 5, 5, 30), chest("q", 5.85, 5, 30), chest("r", 6.7, 5, 30)]);
    expect(stacks.map((s) => s.chests.length).sort()).toEqual([1, 1, 1, 1, 2]);
  });

  it("leaves carts and ships out and keeps the agent's order without heights", () => {
    const stacks = groupStacks([chest("k@0,0", 0, 0, undefined, "ship"), chest("x@3,3#1", 3, 3), chest("x@3,3", 3, 3), chest("x@3,3#2", 3, 3)]);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.ordered).toBe(false);
    expect(stacks[0]!.chests.map((c) => c.id)).toEqual(["x@3,3", "x@3,3#1", "x@3,3#2"]);
  });

  it("lists a stack top first, each chest keeping its level from the bottom", () => {
    // Two wood chests on a floor at 31.85 m, the upper one's pivot 0.9 m higher; handed over top first.
    const [stack] = groupStacks([chest("piece_chest_wood@40,-12#1", 40.15, -11.9, 32.75), chest("piece_chest_wood@40,-12", 40.1, -12.05, 31.85)]);
    expect(stack!.chests.map((c) => c.y)).toEqual([31.85, 32.75]);
    expect(topDown(stack!.chests).map(({ chest: c, index }) => [c.y, index])).toEqual([
      [32.75, 1],
      [31.85, 0],
    ]);
  });

  it("indexes every chest of the mock, with its stacks of two and three", () => {
    const store = mockMap().storage!;
    const stacks = groupStacks(store);
    const at = stackIndex(stacks);
    expect(at.size).toBe(store.filter((c) => c.kind === "chest").length);
    expect(at.get("piece_chest_wood@233,-346#2")).toMatchObject({ index: 2 });
    expect(at.get("piece_chest_wood@233,-346#2")!.stack.chests).toHaveLength(3);
    expect(at.get("piece_chest_wood@208,-352")!.stack.chests).toHaveLength(2);
  });
});
