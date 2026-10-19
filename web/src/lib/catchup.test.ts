import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiCatchup, CatchupWorld } from "../types";
import { catchupItems, readSeen, rebaseOf, seenOf, writeSeen } from "./catchup";

const world = (over: Partial<CatchupWorld> = {}): CatchupWorld => ({
  id: "w1",
  netTime: 5000,
  portals: [{ id: "100,200", x: 100, z: 200 }],
  bases: [{ x: 0, z: 0 }],
  ships: 2,
  carts: 1,
  places: [{ kind: "boss", name: "Eikthyrnir", x: 330, z: 140 }],
  exploredM2: 4_000_000,
  ...over,
});

const answer = (over: Partial<ApiCatchup> = {}): ApiCatchup => ({
  since: "2026-10-08T18:00:00.000Z",
  until: "2026-10-09T18:00:00.000Z",
  clamped: false,
  partial: false,
  players: [],
  raids: 0,
  backups: 0,
  restores: 0,
  restarts: 0,
  updates: [],
  settings: 0,
  bosses: ["defeated_eikthyr"],
  world: world(),
  ...over,
});

describe("catchupItems", () => {
  it("compares the world with what this browser saw", () => {
    const seen = seenOf(answer());
    const now = answer({
      bosses: ["defeated_eikthyr", "defeated_gdking"],
      world: world({
        portals: [...world().portals, { id: "-50,80", x: -50, z: 80 }],
        // The old base grew a little off-centre; one new base far away.
        bases: [{ x: 20, z: 10 }, { x: 2000, z: -900 }],
        ships: 1,
        carts: 3,
        places: [...world().places, { kind: "trader", name: "Vendor_BlackForest", x: -900, z: 400 }],
        exploredM2: 4_300_000,
      }),
    });
    expect(catchupItems(now, seen).map((i) => i.kind)).toEqual(["boss", "place", "bases", "portals", "shipsLost", "carts", "explored"]);
    expect(catchupItems(now, seen)).toContainEqual({ kind: "bases", n: 1, at: { x: 2000, z: -900 } });
    expect(catchupItems(now, seen)).toContainEqual({ kind: "explored", m2: 300_000 });
  });

  it("only takes a new baseline after another world or a restore, with no lines for it", () => {
    const seen = seenOf(answer());
    const changed = { bosses: ["defeated_eikthyr", "defeated_gdking"], world: world({ portals: [], ships: 6, places: [], exploredM2: 9_000_000 }) };
    // Same world, plain play: news.
    expect(catchupItems(answer({ ...changed, world: { ...changed.world, netTime: 6000 } }), seen).length).toBeGreaterThan(0);
    // Another world (a new one, another seed).
    expect(catchupItems(answer({ ...changed, world: { ...changed.world, id: "w2" } }), seen)).toEqual([]);
    // An older copy put back: the world clock went back.
    expect(catchupItems(answer({ ...changed, world: { ...changed.world, netTime: 4000 } }), seen)).toEqual([]);
    // A restore from the panel: only the restore itself is news.
    expect(catchupItems(answer({ ...changed, restores: 1 }), seen).map((i) => i.kind)).toEqual(["restores"]);
  });

  it("takes the new world as the baseline at once on a rebase, keeping the time read", () => {
    const seen = { ...seenOf(answer()), at: "2026-10-08T00:00:00.000Z" };
    const other = answer({ world: world({ id: "w2", ships: 9 }), bosses: ["defeated_eikthyr", "defeated_gdking"] });
    const next = rebaseOf(other, seen)!;
    expect(next).toEqual({ ...seenOf(other), at: seen.at });
    // Done once: the same answer again needs nothing.
    expect(rebaseOf(other, next)).toBeNull();
    // An older copy put back.
    expect(rebaseOf(answer({ world: world({ netTime: 4000 }) }), seen)).not.toBeNull();
    // A restore from the panel is news of its own, read with "Got it": nothing is taken behind the viewer's back.
    expect(rebaseOf(answer({ restores: 1, world: world({ netTime: 6000 }) }), seen)).toBeNull();
    expect(rebaseOf(answer({ world: world({ netTime: 6000, ships: 3 }) }), seen)).toBeNull();
    expect(rebaseOf(other, null)).toBeNull();
  });

  it("keeps the previous world and bosses when the answer has none", () => {
    const prev = seenOf(answer());
    const next = seenOf(answer({ until: "2026-10-10T18:00:00.000Z", world: null, bosses: null }), prev);
    expect(next).toEqual({ ...prev, at: "2026-10-10T18:00:00.000Z" });
    expect(seenOf(answer({ world: null, bosses: null }), null)).toMatchObject({ world: null, bosses: null });
  });

  it("folds many new places into one line", () => {
    const places = Array.from({ length: 5 }, (_, i) => ({ kind: "dungeon" as const, name: `Crypt${i}`, x: i * 100, z: 0 }));
    const items = catchupItems(answer({ world: world({ places: [...world().places, ...places] }) }), seenOf(answer()));
    expect(items).toEqual([{ kind: "places", n: 5, at: places[0] }]);
  });

  it("has no world lines on a first visit or with the map off", () => {
    const changed = answer({ bosses: ["defeated_eikthyr", "defeated_gdking"], world: world({ ships: 5 }) });
    expect(catchupItems(changed, null)).toEqual([]);
    // After a long absence the events cover the last week, but the world is still compared with what was seen.
    expect(catchupItems({ ...changed, clamped: true }, seenOf(answer())).map((i) => i.kind)).toEqual(["boss", "ships"]);
    expect(catchupItems({ ...changed, world: null }, seenOf(answer())).map((i) => i.kind)).toEqual(["boss"]);
    expect(catchupItems(changed, seenOf(answer({ world: null }))).map((i) => i.kind)).toEqual(["boss"]);
  });

  it("lists players, then what the server went through", () => {
    const items = catchupItems(
      answer({
        players: [
          { name: "Ragnar", playtimeMs: 3_600_000, sessions: 1, deaths: 2, online: false },
          // Already on at the start and still playing: not news yet.
          { name: "Freya", playtimeMs: 600_000, sessions: 0, deaths: 0, online: true },
          { name: "Bjorn", playtimeMs: 600_000, sessions: 0, deaths: 0, online: false },
        ],
        raids: 2,
        updates: ["l-1.0.17"],
        restarts: 1,
        restores: 1,
        backups: 3,
        settings: 1,
      }),
      null,
    );
    expect(items.map((i) => (i.kind === "player" ? i.player.name : i.kind))).toEqual(["Ragnar", "Bjorn", "raids", "update", "restarts", "restores", "backups", "settings"]);
  });
});

describe("seen storage", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips, and ignores what it cannot read", () => {
    expect(readSeen()).toBeNull();
    const s = seenOf(answer());
    writeSeen(s);
    expect(readSeen()).toEqual(s);
    localStorage.setItem("skald.catchup", "{bad");
    expect(readSeen()).toBeNull();
    localStorage.setItem("skald.catchup", JSON.stringify({ at: "2026-10-09T18:00:00Z", bosses: null, world: { portals: "x" } }));
    expect(readSeen()).toEqual({ at: "2026-10-09T18:00:00Z", bosses: null, world: null });
    // Bases from another shape are dropped, not read.
    localStorage.setItem("skald.catchup", JSON.stringify({ ...s, world: { ...s.world, bases: [{ x: 1, z: 2 }] } }));
    expect(readSeen()).toEqual({ ...s, world: null });
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readSeen()).toBeNull();
    expect(() => writeSeen(seenOf(answer()))).not.toThrow();
  });
});
