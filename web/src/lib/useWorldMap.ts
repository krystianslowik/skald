import { useEffect, useState } from "react";
import type { ApiMap } from "../types";

export type MapLoad =
  | { status: "loading" }
  | { status: "ready"; map: ApiMap; stale: boolean }
  | { status: "off" }
  | { status: "notReady" }
  | { status: "failed" };

/**
 * GET /api/map. The server answers with an ETag and `no-cache`, so the
 * browser revalidates on every call and a 304 costs nothing; the module-level
 * copy only lets the preview and the full map share one decode.
 */
function isMap(m: unknown): m is ApiMap {
  const x = m as Partial<ApiMap> | null;
  return (
    !!x &&
    typeof x === "object" &&
    !!x.meta &&
    !!x.land &&
    typeof x.land.data === "string" &&
    !!x.explored &&
    [x.pins, x.portals, x.tombstones, x.beds, x.vehicles, x.bases, x.locations, x.terrainEdits].every(Array.isArray)
  );
}

let shared: { key: string; promise: Promise<MapLoad> } | null = null;

export function loadMap(key: string): Promise<MapLoad> {
  if (shared && shared.key === key) return shared.promise;
  const promise = fetch("/api/map", { credentials: "same-origin" })
    .then(async (res): Promise<MapLoad> => {
      if (res.ok) {
        const map = (await res.json()) as ApiMap;
        // Anything that is not a map (an older server, a proxy page) counts as a failure.
        if (!isMap(map)) return { status: "failed" };
        // An older agent sends no storage.
        map.storage ??= [];
        return { status: "ready", map, stale: res.headers?.get("X-Skald-Stale") === "1" };
      }
      if (res.status === 404) return { status: "off" };
      if (res.status === 503) return { status: "notReady" };
      return { status: "failed" };
    })
    .catch((): MapLoad => ({ status: "failed" }));
  shared = { key, promise };
  // A failure is not worth keeping: the next caller asks again.
  void promise.then((r) => {
    if (r.status !== "ready" && shared?.promise === promise) shared = null;
  });
  return promise;
}

/** The world map; `key` changes (a new save) trigger a refetch. */
export function useWorldMap(key: string): [MapLoad, () => void] {
  const [load, setLoad] = useState<MapLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void loadMap(`${key}#${attempt}`).then((r) => {
      if (live) setLoad((prev) => (r.status === "failed" && prev.status === "ready" ? prev : r));
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);
  return [load, () => setAttempt((a) => a + 1)];
}
