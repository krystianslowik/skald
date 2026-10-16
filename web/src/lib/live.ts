// Live player positions (the agent's `positions` samples, every 2 s while
// someone plays and someone looks). Kept outside React state like the log
// tail: only the map's marker layer and the player lists subscribe, so the
// dashboard does not re-render with every sample. Mounting one of them is
// also what asks the server for positions at all (see watchPositions).

import { useEffect, useSyncExternalStore } from "react";
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

let watchers = 0;
let sink: ((on: boolean) => void) | null = null;

/** Whether anything on the page shows positions right now. */
export const watchingPositions = (): boolean => watchers > 0;

/**
 * Where the first watcher and the last one going are reported: the /live
 * socket, which subscribes and unsubscribes. One sink at a time.
 */
export function setPositionsSink(fn: ((on: boolean) => void) | null): void {
  sink = fn;
}

/**
 * Asks for live positions until the returned function is called. Counted, so
 * the map and a player list open together subscribe once; after the last one
 * goes the markers are cleared, not left for the next time the map opens.
 */
export function watchPositions(): () => void {
  watchers += 1;
  if (watchers === 1) sink?.(true);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    watchers -= 1;
    if (watchers > 0) return;
    sink?.(false);
    setLivePositions({ t: 0, players: [] });
  };
}

/** The latest positions; a component using this asks for them while mounted. */
export function useLivePositions(): LiveSample {
  useEffect(() => watchPositions(), []);
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
