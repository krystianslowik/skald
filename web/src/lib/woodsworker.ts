// The main thread's side of the woods worker (woods.worker.ts): it mirrors
// the loaded nature and the terrain edits into the worker as they change and
// hands out chunk draws as promises. Until the worker says it can draw (an
// OffscreenCanvas with a 2D context, Path2D, DOMMatrix), and for good once
// it cannot or fails, `ready` is false and the map draws its woods itself.

import { packNature, type NatureItem } from "./nature";
import type { ChunkKey } from "./pieces";
import type { TileRef } from "./terraintiles";
import type { HeatSpot } from "./woodsraster";
import type { WoodsReply, WoodsRequest } from "./woods.worker";

export interface WoodsDraw {
  t: TileRef;
  R: number;
  k: number;
  at: number;
  canopy: number;
  woods: boolean;
  heat: boolean;
  layers: { nature: boolean; pickables: boolean };
}

/** How long one chunk may take in the worker before it is given up on (a dense chunk takes tens of ms on a slow phone). */
const DRAW_TIMEOUT_MS = 10_000;

type Port = Pick<Worker, "postMessage" | "terminate"> & { onmessage: ((e: MessageEvent<WoodsReply>) => void) | null; onerror: ((e: Event) => void) | null };

export class WoodsWorker {
  private worker: Port | null = null;
  private state: "probing" | "ready" | "off" = "off";
  private sent = new Map<ChunkKey, readonly NatureItem[]>();
  private heatOf: number | null = null;
  private nextId = 1;
  private waiting = new Map<number, (px: Uint8ClampedArray<ArrayBuffer> | null) => void>();
  /** Called once the worker can draw, so the map asks it from the next frame. */
  onReady: (() => void) | null = null;

  /** `make`: the worker to use, or null where workers are missing (tests pass their own). */
  constructor(make: () => Port | null = defaultWorker) {
    try {
      this.worker = make();
    } catch {
      this.worker = null;
    }
    if (!this.worker) return;
    this.state = "probing";
    this.worker.onmessage = (e) => this.receive(e.data);
    this.worker.onerror = () => this.fail();
    this.post({ type: "probe" });
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  /** Draws in flight. */
  get inflight(): number {
    return this.waiting.size;
  }

  private post(m: WoodsRequest, transfer: Transferable[] = []) {
    try {
      this.worker?.postMessage(m, transfer);
    } catch {
      this.fail();
    }
  }

  private receive(m: WoodsReply) {
    if (m.type === "probe") {
      if (!m.ok) return this.fail();
      if (this.state !== "probing") return;
      this.state = "ready";
      this.onReady?.();
      return;
    }
    const done = this.waiting.get(m.id);
    this.waiting.delete(m.id);
    done?.(m.px);
  }

  /** The worker cannot draw: stop it, and every draw waiting gets null (draw it here instead). */
  private fail() {
    this.state = "off";
    this.worker?.terminate();
    this.worker = null;
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }

  /** The loaded nature: only chunks that arrived, changed or left since the last call are sent. */
  setNature(loaded: ReadonlyMap<ChunkKey, readonly NatureItem[]>): void {
    if (!this.worker) return;
    const add: [string, ReturnType<typeof packNature>][] = [];
    const drop: string[] = [];
    for (const [k, items] of loaded) if (this.sent.get(k) !== items) add.push([k, packNature(items)]);
    for (const k of this.sent.keys()) if (!loaded.has(k)) drop.push(k);
    if (!add.length && !drop.length) return;
    this.sent = new Map(loaded);
    this.post({ type: "nature", add, drop }, add.map(([, p]) => p.data.buffer));
  }

  /** The terrain edits; `version` changes when they do (a new snapshot with the same edits sends nothing). */
  setHeat(spots: readonly HeatSpot[], version: number): void {
    if (!this.worker || version === this.heatOf) return;
    this.heatOf = version;
    this.post({ type: "heat", spots: spots.map(({ x, z, cells }) => ({ x, z, cells })) });
  }

  /**
   * A chunk's premultiplied pixels, or null when the worker could not draw
   * it. A worker that does not answer within DRAW_TIMEOUT_MS (killed without
   * an error, stuck) is given up on for good: every draw then happens here.
   */
  draw(d: WoodsDraw): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
    if (this.state !== "ready") return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.fail(), DRAW_TIMEOUT_MS);
      this.waiting.set(id, (px) => {
        clearTimeout(timer);
        resolve(px);
      });
      this.post({ type: "draw", id, ...d });
    });
  }

  dispose(): void {
    this.fail();
    this.onReady = null;
  }
}

function defaultWorker(): Port | null {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  return new Worker(new URL("./woods.worker.ts", import.meta.url), { type: "module" }) as Port;
}
