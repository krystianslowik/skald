import type { ApiMap, ApiStorage, MapSnapshot } from "./types";

/**
 * Spoiler gating. With spoilers off only locations someone has found stay:
 * placed by the game and inside the explored area (or next to a base). The
 * agent sends every location of the listed kinds; the seed alone would give
 * away where every boss and dungeon is.
 */
export function gateMap(snap: MapSnapshot, spoilers: boolean): ApiMap {
  const locations = spoilers ? snap.locations : snap.locations.filter((l) => l.placed && l.explored);
  return { ...snap, storage: snap.storage ?? [], locations, spoilers, hiddenLocations: snap.locations.length - locations.length };
}

/** The village stores: every player-built container, nothing else of the map. */
export function storageOf(map: ApiMap): ApiStorage {
  return { generation: map.meta.generation, savedAt: map.meta.savedAt, showNames: map.meta.showNames, containers: map.storage };
}
