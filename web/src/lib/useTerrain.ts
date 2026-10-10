import { useEffect, useState } from "react";
import type { TerrainDoc } from "../types";
import type { Relief } from "./maprender";

export type TerrainLoad = { status: "none" } | { status: "ready"; doc: TerrainDoc; relief: Relief };

function isDoc(x: unknown): x is TerrainDoc {
  const d = x as Partial<TerrainDoc> | null;
  return !!d && typeof d.build === "string" && typeof d.radius === "number" && d.radius > 0;
}

let shared: { key: string; promise: Promise<TerrainLoad> } | null = null;

/**
 * GET /api/terrain.json, then the image it names, decoded once per build
 * (the URL carries the build, so the browser caches it for good). No terrain,
 * or one that fails to load, is simply "none": the map inks the land from
 * the save as before.
 */
export function loadTerrain(key: string): Promise<TerrainLoad> {
  if (shared?.key === key) return shared.promise;
  const none: TerrainLoad = { status: "none" };
  const promise = fetch("/api/terrain.json", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then(
      (doc: unknown) =>
        new Promise<TerrainLoad>((resolve) => {
          if (!isDoc(doc) || typeof Image === "undefined") return resolve(none);
          const img = new Image();
          img.decoding = "async";
          img.onload = () => resolve({ status: "ready", doc, relief: { img, radius: doc.radius } });
          img.onerror = () => resolve(none);
          img.src = `/api/terrain.png?v=${encodeURIComponent(doc.build)}`;
        }),
    )
    .catch(() => none);
  shared = { key, promise };
  return promise;
}

/** The terrain for the map; `key` changes (a new save) look again. */
export function useTerrain(key: string): TerrainLoad {
  const [load, setLoad] = useState<TerrainLoad>({ status: "none" });
  useEffect(() => {
    let live = true;
    void loadTerrain(key).then((r) => {
      if (live) setLoad((prev) => (r.status === "none" && prev.status === "ready" ? prev : r));
    });
    return () => {
      live = false;
    };
  }, [key]);
  return load;
}
