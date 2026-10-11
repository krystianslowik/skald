import { describe, expect, it, vi } from "vitest";
import { mockNature, natureIn } from "@server/mocknature";
import { en } from "../i18n/en";
import { pl } from "../i18n/pl";
import { decodeNature, NATURE_CHUNK, natureLayer, natureLoader, natureTint, ORE_YIELD, oreKey, wobble } from "./nature";
import { natureAlpha } from "./naturerender";

const all = mockNature();
const settle = () => new Promise((r) => setTimeout(r, 0));
const boxOf = (url: string) => ["x0", "z0", "x1", "z1"].map((k) => Number(new URL(url, "http://x").searchParams.get(k))) as [number, number, number, number];

function agent(max = 30_000) {
  return vi.fn(async (url: string | URL | Request) => Response.json(natureIn(all, boxOf(String(url)), 1, false, max)));
}

describe("decodeNature", () => {
  it("turns the compact answer into items sized by their scale", () => {
    const items = decodeNature({
      kinds: [
        ["Beech1", "tree", "beech", 8],
        ["rock4_copper", "ore", "copper", 6],
        ["Strange", "weather", "x", 1],
      ],
      items: [
        [0, 104.2, -211.7, 148, 1.15],
        [1, 131, -190.4, 0, 1],
        [2, 1, 1, 0, 1],
        [0, "a", 1, 0, 1],
        [9, 1, 1, 0, 1],
      ],
    });
    expect(items).toEqual([
      { category: "tree", species: "beech", x: 104.2, z: -211.7, yaw: 148, size: 8 * 1.15 },
      { category: "ore", species: "copper", x: 131, z: -190.4, yaw: 0, size: 6 },
    ]);
  });

  it("is null for anything that is not a nature answer", () => {
    expect(decodeNature(null)).toBeNull();
    expect(decodeNature({ prefabs: [], pieces: [] })).toBeNull();
    expect(decodeNature("<!doctype html>")).toBeNull();
  });
});

describe("tints and names", () => {
  it("gives every category a tint and keeps ore and pickables apart from the woods", () => {
    expect(natureTint("tree", "beech")).not.toBe(natureTint("tree", "fir"));
    expect(natureTint("tree", "unknown")).toBe(natureTint("tree", "beech"));
    expect(natureTint("ore", "copper")).not.toBe(natureTint("ore", "tin"));
    for (const c of ["tree", "stump", "log", "rock", "bush", "ore", "pickable"] as const) expect(natureTint(c, "x")).toMatch(/^#[0-9a-f]{6}$/);
    expect(natureLayer("ore")).toBe("resources");
    expect(natureLayer("pickable")).toBe("resources");
    expect(natureLayer("rock")).toBe("nature");
  });

  it("names every ore in both languages, and what it yields", () => {
    const ores = ["copper", "tin", "iron", "silver", "obsidian", "tar", "guck", "meteorite", "giant", "softtissue", "flametal", "chitin"];
    for (const o of ores) {
      expect(en).toHaveProperty(oreKey(o));
      expect(pl).toHaveProperty(oreKey(o));
    }
    for (const item of Object.values(ORE_YIELD)) expect(en).toHaveProperty(`item.${item}`);
    for (const k of ["map.layer.nature", "map.layer.resources", "map.ore.unknown", "map.ore.yields"]) {
      expect(en).toHaveProperty(k);
      expect(pl).toHaveProperty(k);
    }
  });

  it("wobbles the same way for the same object, and differently for another", () => {
    const a = { x: 10.2, z: -3, yaw: 40 };
    expect(wobble(a, 1)).toBe(wobble({ ...a }, 1));
    expect(wobble(a, 1)).not.toBe(wobble({ ...a, x: 10.3 }, 1));
    expect(Math.abs(wobble(a, 5))).toBeLessThanOrEqual(1);
  });

  it("fades in between 0.8 and 1.5 px per metre", () => {
    expect(natureAlpha(0.5)).toBe(0);
    expect(natureAlpha(0.8)).toBe(0);
    expect(natureAlpha(1.1)).toBeGreaterThan(0);
    expect(natureAlpha(1.1)).toBeLessThan(1);
    expect(natureAlpha(1.5)).toBe(1);
  });
});

describe("the nature loader", () => {
  it("fetches 256 m chunks once, and a pan over them costs nothing", async () => {
    const fetchImpl = agent();
    const l = natureLoader(fetchImpl as typeof fetch);
    const changed = vi.fn();
    l.onChange = changed;
    l.want([260, -150, 300, -120], "1");
    await settle();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`/api/nature?x0=256&z0=-256&x1=512&z1=0`);
    expect(changed).toHaveBeenCalled();
    const chunk = l.loaded.get("1,-1")!;
    expect(chunk.length).toBeGreaterThan(500);
    expect(chunk.every((it) => it.x >= 256 && it.x < 2 * NATURE_CHUNK && it.z >= -256 && it.z < 0)).toBe(true);
    l.want([270, -140, 310, -110], "1");
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("splits a truncated answer into quarters and loses nothing", async () => {
    const full = natureLoader(agent() as typeof fetch);
    full.want([200, -200, 240, -150], "1");
    const cut = agent(400);
    const split = natureLoader(cut as typeof fetch);
    split.want([200, -200, 240, -150], "1");
    for (let i = 0; i < 30; i++) await settle();
    expect(cut.mock.calls.length).toBeGreaterThanOrEqual(5);
    const count = (l: typeof full) => [...l.loaded.values()].reduce((n, c) => n + c.length, 0);
    expect(count(split)).toBe(count(full));
    expect(count(split)).toBeGreaterThan(400);
  });

  it("asks an agent without nature once per save and then leaves it be", async () => {
    const old = vi.fn(async () => new Response("404 page not found", { status: 404 }));
    const l = natureLoader(old as typeof fetch);
    l.want([0, 0, 10, 10], "1");
    await settle();
    await settle();
    l.want([0, 0, 1000, 10], "1");
    l.want([3000, 3000, 3100, 3100], "1");
    await settle();
    expect(old).toHaveBeenCalledTimes(1);
    expect(l.loaded.size).toBe(0);
    // The floor plans' answer (or a page) from a server whose nature route is something else counts as none too.
    const pieces = vi.fn(async () => Response.json({ prefabs: [], pieces: [] }));
    const p = natureLoader(pieces as typeof fetch);
    p.want([0, 0, 10, 10], "1");
    await settle();
    await settle();
    p.want([600, 0, 610, 10], "1");
    await settle();
    expect(pieces).toHaveBeenCalledTimes(1);
  });
});
