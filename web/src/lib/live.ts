// Live player positions (the agent's `positions` samples, every 2 s while
// someone plays). Kept outside React state like the log tail: only the map's
// marker layer and the player lists subscribe, so the dashboard does not
// re-render with every sample.

import { useSyncExternalStore } from "react";
import type { LivePlayer } from "../types";
import { springStep } from "./mapmotion";

export interface LiveSample {
  /** When the sample was taken (agent clock, ms). */
  t: number;
  players: LivePlayer[];
}

let current: LiveSample = { t: 0, players: [] };
const subs = new Set<() => void>();

export function setLivePositions(next: LiveSample): void {
  current = next;
  for (const f of subs) f();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function useLivePositions(): LiveSample {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

export const getLivePositions = (): LiveSample => current;

/** Beyond this jump (a portal, a teleport) a marker moves at once instead of gliding. */
const SNAP_M = 250;

interface Track {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/**
 * Smooths markers between 2 s samples: each one glides to its latest sample
 * on a critically damped spring that keeps its velocity when the next sample
 * arrives, so a walking player moves steadily instead of hopping.
 */
export class Glide {
  private tracks = new Map<string, Track>();

  /** Advance every marker by dt seconds towards `players`; returns whether any is still moving. */
  step(players: readonly LivePlayer[], dt: number, reduced: boolean): boolean {
    let moving = false;
    const seen = new Set<string>();
    for (const p of players) {
      seen.add(p.name);
      let tr = this.tracks.get(p.name);
      if (!tr || reduced || Math.hypot(p.x - tr.x, p.z - tr.z) > SNAP_M) {
        this.tracks.set(p.name, { x: p.x, z: p.z, vx: 0, vz: 0 });
        continue;
      }
      const sx = springStep(tr.x, tr.vx, p.x, dt, 1.6);
      const sz = springStep(tr.z, tr.vz, p.z, dt, 1.6);
      tr = { x: sx.x, z: sz.x, vx: sx.v, vz: sz.v };
      this.tracks.set(p.name, tr);
      if (Math.abs(tr.x - p.x) > 0.05 || Math.abs(tr.z - p.z) > 0.05) moving = true;
    }
    for (const name of [...this.tracks.keys()]) if (!seen.has(name)) this.tracks.delete(name);
    return moving;
  }

  at(name: string): { x: number; z: number } | null {
    return this.tracks.get(name) ?? null;
  }
}
