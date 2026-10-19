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

/** A player's marker on screen: the dot's centre, and the size of its name plate. */
export interface PlateBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a name plate sits under its dot (px from the dot's centre to the plate's top). */
export const PLATE_TOP = 12;
/** The dot's footprint (px), which another player's plate must not cover. */
const DOT = 18;
/** Space kept between a plate and whatever it was moved clear of (px). */
const PLATE_GAP = 2;
/** Two plates trade places in the stack only once their dots are this far apart vertically (px), so walking side by side does not flicker. */
const SWAP_PX = 6;

/**
 * Moves name plates apart so players standing together can all be read: each
 * plate starts under its own dot and, while it would cover a plate already
 * placed or another player's dot, goes down past it. Plates are placed from
 * the topmost dot down, so the stack keeps the dots' order; `prev` (the order
 * returned last time) keeps two dots at nearly the same height from trading
 * places on every frame. Returns how far down each plate moved (px, 0 when it
 * was clear) and the order to pass next time.
 */
export function stackPlates(boxes: readonly PlateBox[], prev: readonly string[] = []): { shift: number[]; order: string[] } {
  const shift = boxes.map(() => 0);
  const rank = new Map(prev.map((id, i) => [id, i]));
  // Last time's order first (newcomers after it, by height), then swap neighbours whose dots are clearly the other way round.
  const order = boxes.map((_, i) => i).sort((a, b) => (rank.get(boxes[a]!.id) ?? Infinity) - (rank.get(boxes[b]!.id) ?? Infinity) || boxes[a]!.y - boxes[b]!.y || boxes[a]!.x - boxes[b]!.x);
  for (let swapped = true; swapped; ) {
    swapped = false;
    for (let k = 0; k + 1 < order.length; k++) {
      if (boxes[order[k]!]!.y - boxes[order[k + 1]!]!.y > SWAP_PX) {
        [order[k], order[k + 1]] = [order[k + 1]!, order[k]!];
        swapped = true;
      }
    }
  }
  type Rect = { l: number; r: number; t: number; b: number };
  const taken: Rect[] = [];
  const dots: (Rect & { i: number })[] = boxes.map((b, i) => ({ i, l: b.x - DOT / 2, r: b.x + DOT / 2, t: b.y - DOT / 2, b: b.y + DOT / 2 }));
  for (const i of order) {
    const b = boxes[i]!;
    const l = b.x - b.w / 2;
    const r = b.x + b.w / 2;
    let t = b.y + PLATE_TOP;
    for (;;) {
      const hit =
        taken.find((o) => l < o.r + PLATE_GAP && r > o.l - PLATE_GAP && t < o.b + PLATE_GAP && t + b.h > o.t - PLATE_GAP) ??
        dots.find((o) => o.i !== i && l < o.r && r > o.l && t < o.b + PLATE_GAP && t + b.h > o.t);
      if (!hit) break;
      t = hit.b + PLATE_GAP;
    }
    taken.push({ l, r, t, b: t + b.h });
    shift[i] = t - b.y - PLATE_TOP;
  }
  return { shift, order: order.map((i) => boxes[i]!.id) };
}
