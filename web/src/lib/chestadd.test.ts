import { afterEach, describe, expect, it } from "vitest";
import type { MapContainer } from "../types";
import { canAddTo, chestRoom, clearPending, notePending, pendingItems, withSlots } from "./chestadd";

const chest = (over: Partial<MapContainer> = {}): MapContainer => ({
  id: "piece_chest_wood@10,-4",
  kind: "chest",
  prefab: "piece_chest_wood",
  x: 10,
  y: 31.25,
  z: -4,
  width: 5,
  height: 2,
  items: [
    { name: "Wood", stack: 30, x: 0, y: 0 },
    { name: "Stone", stack: 50, x: 1, y: 0 },
  ],
  ...over,
});

afterEach(clearPending);

describe("chest add", () => {
  it("counts the room left in stacks of the item and in empty slots", () => {
    const c = chest();
    expect(chestRoom(c, c.items, "Wood")).toBe(20 + 8 * 50);
    expect(chestRoom(c, c.items, "Stone")).toBe(8 * 50);
    // One per slot for things that do not stack.
    expect(chestRoom(c, c.items, "SwordIron")).toBe(8);
  });

  it("trusts a stack bigger than the guessed stack size", () => {
    const c = chest({ items: [{ name: "Honey", stack: 40, x: 0, y: 0 }] });
    expect(chestRoom(c, c.items, "Honey")).toBe(9 * 40);
  });

  it("has no room in a full chest and caps a huge one", () => {
    const full = chest({ width: 1, height: 1, items: [{ name: "Stone", stack: 50, x: 0, y: 0 }] });
    expect(chestRoom(full, full.items, "Stone")).toBe(0);
    expect(chestRoom(full, full.items, "Wood")).toBe(0);
    const big = chest({ width: 40, height: 40, items: [] });
    expect(chestRoom(big, big.items, "Wood")).toBe(9999);
  });

  it("takes only chests the save could read and that carry a height", () => {
    expect(canAddTo(chest())).toBe(true);
    expect(canAddTo(chest({ kind: "cart" }))).toBe(false);
    expect(canAddTo(chest({ unreadable: true }))).toBe(false);
    expect(canAddTo(chest({ width: 0 }))).toBe(false);
    expect(canAddTo(chest({ y: undefined }))).toBe(false);
  });

  it("applies the slots the bridge reported", () => {
    const c = chest();
    const out = withSlots(c.items, "Wood", [
      { x: 0, y: 0, added: 20, stack: 50 },
      { x: 2, y: 0, added: 15, stack: 15 },
    ]);
    expect(out).toEqual([
      { name: "Wood", stack: 50, x: 0, y: 0 },
      { name: "Stone", stack: 50, x: 1, y: 0 },
      { name: "Wood", stack: 15, x: 2, y: 0 },
    ]);
    // The saved contents are left as they were.
    expect(c.items[0]!.stack).toBe(30);
  });

  it("keeps added items until a save shows the chest changed", () => {
    const c = chest();
    expect(pendingItems(c)).toBeNull();
    notePending(c, "Iron", [{ x: 2, y: 0, added: 10, stack: 10 }]);
    notePending(c, "Iron", [{ x: 2, y: 0, added: 5, stack: 15 }]);
    expect(pendingItems(c)).toContainEqual({ name: "Iron", stack: 15, x: 2, y: 0 });
    // The next save holds the chest with the iron in it: the save is the truth again.
    const saved = chest({ items: [...c.items, { name: "Iron", stack: 15, x: 2, y: 0 }] });
    expect(pendingItems(saved)).toBeNull();
  });
});
