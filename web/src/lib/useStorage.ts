import { useEffect, useState } from "react";
import type { ApiStorage } from "../types";

export type StorageLoad = { status: "loading" } | { status: "ready"; storage: ApiStorage } | { status: "off" } | { status: "failed" };

function isStorage(s: unknown): s is ApiStorage {
  const x = s as Partial<ApiStorage> | null;
  return !!x && typeof x === "object" && Array.isArray(x.containers);
}

/** Reads in flight by save key: the stores and the task board mounted together ask once. */
const pending = new Map<string, Promise<StorageLoad>>();

function read(key: string): Promise<StorageLoad> {
  let p = pending.get(key);
  if (!p) {
    p = fetch("/api/storage", { credentials: "same-origin" })
      .then(async (res): Promise<StorageLoad> => {
        if (res.ok) {
          const body = (await res.json()) as unknown;
          return isStorage(body) ? { status: "ready", storage: body } : { status: "failed" };
        }
        return res.status === 404 ? { status: "off" } : { status: "failed" };
      })
      .catch((): StorageLoad => ({ status: "failed" }))
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

/**
 * GET /api/storage: every player-built container, without the rest of the
 * map. Revalidated by ETag like the map; `key` changes (a new save) refetch.
 * A failed refresh keeps what was already shown.
 */
export function useStorage(key: string): [StorageLoad, () => void] {
  const [load, setLoad] = useState<StorageLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void read(key).then((r) => {
      if (live) setLoad((prev) => (r.status === "failed" && prev.status === "ready" ? prev : r));
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);
  return [load, () => setAttempt((a) => a + 1)];
}
