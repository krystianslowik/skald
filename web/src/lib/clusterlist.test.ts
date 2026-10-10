import { describe, expect, it } from "vitest";
import { makeI18n } from "../i18n";
import { clusterSummary, mergeStacks, sortCluster, stackText, summarize } from "./clusterlist";
import type { Marker } from "./mapgeo";
import type { MapItem } from "../types";

const en = makeI18n("en");
const pl = makeI18n("pl");
const item = (name: string, stack: number, x = 0): MapItem => ({ name, stack, x, y: 0 }) as MapItem;

const chest = (id: string, items: MapItem[], width = 5): Marker =>
  ({ id, x: 0, z: 0, label: "Chest", icon: "chest", priority: 1, rank: 1, labelScale: 1, data: { type: "storage", store: { id, prefab: "piece_chest_wood", width, height: 2, items } } }) as unknown as Marker;
const pin = (id: string): Marker => ({ id, x: 0, z: 0, label: "Pin", icon: "pin", priority: 1, rank: 1, labelScale: 1, data: { type: "pin", kind: "other", name: "" } }) as unknown as Marker;

describe("cluster summaries", () => {
  it("merges stacks by name, biggest first", () => {
    const m = mergeStacks([item("Stone", 20), item("Wood", 30), item("Wood", 20, 1)], en.lookup);
    expect(m.map((s) => [s.name, s.total])).toEqual([["Wood", 50], ["Stone", 20]]);
  });

  it("keeps the top three and counts the rest", () => {
    const s = summarize([item("Wood", 50), item("Stone", 20), item("Coal", 10), item("Flint", 5), item("Resin", 1)], en.lookup);
    expect(s.top.map((x) => x.name)).toEqual(["Wood", "Stone", "Coal"]);
    expect(s.more).toBe(2);
    expect(summarize([], en.lookup)).toEqual({ top: [], more: 0 });
  });

  it("formats a stack in both languages", () => {
    const [s] = mergeStacks([item("Wood", 1500)], en.lookup);
    expect(stackText(s!, en.number)).toBe("1,500× Wood");
    const [p] = mergeStacks([item("Wood", 50)], pl.lookup);
    expect(stackText(p!, pl.number)).toBe(`50× ${pl.lookup("item.Wood")}`);
  });

  it("sorts fullest first, other marks next, empty containers last", () => {
    const a = chest("a", [item("Wood", 5)]);
    const b = chest("b", [item("Wood", 50), item("Stone", 20)]);
    const e = chest("e", []);
    const p = pin("p");
    const raft = chest("r", [], 0);
    expect(sortCluster([e, a, p, raft, b]).map((m) => m.id)).toEqual(["b", "a", "p", "e", "r"]);
  });

  it("totals the whole pile", () => {
    const s = clusterSummary([chest("a", [item("Wood", 5)]), chest("b", [item("Wood", 50)]), pin("p")], en.lookup);
    expect(s.top.map((x) => [x.name, x.total])).toEqual([["Wood", 55]]);
  });
});
