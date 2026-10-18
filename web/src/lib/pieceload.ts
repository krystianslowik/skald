// Fetches what the map draws at close zoom (floor plans, nature) in aligned
// chunks, and keeps them per save: a pan over loaded chunks costs nothing, a
// new save asks again (the browser revalidates each chunk by its ETag, so an
// unchanged chunk is a 304). An agent without the endpoint answers 404 to the
// first request and is not asked again for that save; any other failure is
// that chunk's alone, asked again after a backoff.

import { chunkBox, chunksFor, CHUNK, decodePieces, inBox, quarters, type ChunkKey, type Piece } from "./pieces";

type Box = [number, number, number, number];

/** At most this many requests in flight, for all the loaders sharing a Lanes. */
const PARALLEL = 4;
/** A truncated answer is split until boxes are this small. */
const MIN_SIDE = 64;
/** A failed chunk is asked again after this long, doubling with each failure up to RETRY_MAX. */
export const RETRY_FIRST = 1000;
export const RETRY_MAX = 20_000;
/** After this many failures in a row, with nothing answering in between, the whole layer waits too. */
const STREAK = 3;
/** Chunks kept per layer; past this the ones loaded longest ago, out of the view, are let go. */
const KEEP = 300;

export interface ChunkSource<T> {
  /** The API path, without the query. */
  path: string;
  /** Chunk side in metres. */
  chunk: number;
  /** The answer's items, or null when it is not one (an older server, a proxy page). */
  decode: (body: unknown) => T[] | null;
}

/** What a loader can tell the perf harness (?mapstats). */
export interface LoaderStats {
  loaded: number;
  inflight: number;
  queued: number;
  /** Chunks waiting out a backoff. */
  failed: number;
  off: boolean;
  /** The loader clock's time of the last chunk that arrived, 0 before any. */
  arrived: number;
}

/**
 * Request slots shared by several loaders. A free slot goes to the chunk of
 * the lowest tier (the view before the ring round it); on a tie, to the
 * loader that joined first.
 */
interface Lane {
  head(): number | null;
  launch(): void;
}

export class Lanes {
  busy = 0;
  private readonly loaders: Lane[] = [];
  private soon = false;

  constructor(readonly max = PARALLEL) {}

  join(l: Lane): void {
    this.loaders.push(l);
  }

  /** Pumps once the current task is done: loaders asked one after another share the slots by tier, not by who asked first. */
  pumpSoon(): void {
    if (this.soon) return;
    this.soon = true;
    queueMicrotask(() => {
      this.soon = false;
      this.pump();
    });
  }

  pump(): void {
    while (this.busy < this.max) {
      let best: Lane | null = null;
      let tier = Infinity;
      for (const l of this.loaders) {
        const t = l.head();
        if (t !== null && t < tier) {
          best = l;
          tier = t;
        }
      }
      if (!best) return;
      best.launch();
    }
  }
}

/** Ask again later; `wait`: how long the server said to wait (Retry-After), in ms. */
interface Later {
  wait: number;
}
const LATER: Later = { wait: 0 };
type Result<T> = T[] | "off" | "aborted" | Later;

export class ChunkLoader<T extends { x: number; z: number }> {
  /** Chunks loaded for the current save (or kept from the last one until refetched). */
  private chunks = new Map<ChunkKey, { key: string; items: T[] }>();
  private inflight = new Map<ChunkKey, AbortController>();
  /** Chunks to ask for, in order, with their tier (0 the view, 1 the ring). */
  private queue: { c: ChunkKey; tier: number }[] = [];
  /** Chunks whose last request failed: how often, and not before when to ask again. */
  private failed = new Map<ChunkKey, { n: number; at: number }>();
  private key = "";
  /** The server has none of this for this save. */
  private off = false;
  /** Some request for this save got a proper answer: a 404 now is a hiccup, not a missing endpoint. */
  private answered = false;
  /** Failures in a row, and until when the whole layer waits (the agent is down or busy). */
  private streak = 0;
  private holdUntil = 0;
  private wanted: ReadonlySet<ChunkKey> = new Set();
  private last: { box: Box; key: string; ring: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = Infinity;
  private listeners = new Set<() => void>();
  private arrivedAt = 0;
  /** Every loaded chunk's items; a new map whenever a chunk arrives. */
  loaded: ReadonlyMap<ChunkKey, readonly T[]> = new Map();

  constructor(
    private readonly src: ChunkSource<T>,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly clock: () => number = Date.now,
    private readonly lanes: Lanes = new Lanes(),
  ) {
    lanes.join(this);
  }

  /** Called whenever a chunk arrives; returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Asks for the chunks `box` touches, and with `ring` that many chunks
   * round it, for save `key`; those already loaded for it are skipped.
   * What an earlier call wanted and this one does not is cancelled.
   */
  want(box: readonly [number, number, number, number], key: string, ring = 0): void {
    if (key !== this.key) {
      this.drop();
      this.key = key;
      this.off = false;
      this.answered = false;
      this.failed.clear();
    }
    this.last = { box: [...box], key, ring };
    if (this.off) return;
    const size = this.src.chunk;
    const pad = ring * size;
    const core = new Set(chunksFor(box, size));
    const all = pad > 0 ? chunksFor([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad], size) : [...core];
    const wanted = new Set(all);
    this.wanted = wanted;
    // Wanted again: loaded chunks move to the end, the last to be let go.
    for (const c of all) {
      const had = this.chunks.get(c);
      if (had) {
        this.chunks.delete(c);
        this.chunks.set(c, had);
      }
    }
    for (const [c, ac] of this.inflight) {
      if (wanted.has(c)) continue;
      ac.abort();
      this.inflight.delete(c);
    }
    const now = this.clock();
    // Nearest first: the view's middle chunk before its corners, the view before the ring.
    const mx = (box[0] + box[2]) / 2;
    const mz = (box[1] + box[3]) / 2;
    const dist = (c: ChunkKey) => {
      const b = chunkBox(c, size);
      return Math.hypot((b[0] + b[2]) / 2 - mx, (b[1] + b[3]) / 2 - mz);
    };
    this.queue = all
      .filter((c) => this.chunks.get(c)?.key !== key && !this.inflight.has(c) && !((this.failed.get(c)?.at ?? 0) > now))
      .map((c) => ({ c, tier: core.has(c) ? 0 : 1, d: dist(c) }))
      .sort((a, b) => a.tier - b.tier || a.d - b.d)
      .map(({ c, tier }) => ({ c, tier }));
    this.arm(wanted, now);
    this.lanes.pumpSoon();
  }

  /** Wants nothing for now: requests in flight are cancelled, what has loaded stays. */
  drop(): void {
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
    this.queue = [];
    this.wanted = new Set();
    this.last = null;
    this.disarm();
  }

  /** The map closed: as drop, and the next one asks afresh, even an agent that answered 404 before. */
  close(): void {
    this.drop();
    this.off = false;
    this.answered = false;
    this.failed.clear();
    this.streak = 0;
    this.holdUntil = 0;
  }

  stats(): LoaderStats {
    return { loaded: this.loaded.size, inflight: this.inflight.size, queued: this.queue.length, failed: this.failed.size, off: this.off, arrived: this.arrivedAt };
  }

  /** The tier of the next chunk to ask for, or null when there is none. */
  head(): number | null {
    return this.off || !this.queue.length || this.clock() < this.holdUntil ? null : this.queue[0]!.tier;
  }

  /** Starts the next chunk's request (Lanes calls this when a slot is free). */
  launch(): void {
    const { c } = this.queue.shift()!;
    if (this.chunks.get(c)?.key === this.key || this.inflight.has(c)) return;
    const ac = new AbortController();
    this.inflight.set(c, ac);
    this.lanes.busy++;
    const key = this.key;
    void this.load(chunkBox(c, this.src.chunk), ac.signal)
      .then((items) => {
        if (key !== this.key || ac.signal.aborted || items === "aborted") return;
        if (items === "off") {
          this.off = true;
          this.queue = [];
          this.disarm();
        } else if (!Array.isArray(items)) {
          // Not built yet, unreachable, cut off: this chunk waits, longer each time, and the rest go on.
          const now = this.clock();
          const n = (this.failed.get(c)?.n ?? 0) + 1;
          const at = now + Math.min(RETRY_MAX, RETRY_FIRST * 2 ** (n - 1));
          this.failed.set(c, { n, at });
          // Failing again and again, or told to wait: the agent is down or busy, so the whole layer waits as well.
          this.streak++;
          if (this.streak >= STREAK || items.wait > 0) {
            const wait = Math.min(RETRY_MAX, Math.max(items.wait, this.streak >= STREAK ? RETRY_FIRST * 2 ** (this.streak - STREAK) : 0));
            this.holdUntil = Math.max(this.holdUntil, now + wait);
          }
          const next = this.holdUntil > now ? Math.min(at, this.holdUntil) : at;
          if (next < this.retryAt) this.schedule(next);
        } else {
          this.failed.delete(c);
          this.streak = 0;
          this.holdUntil = 0;
          this.chunks.delete(c);
          this.chunks.set(c, { key, items });
          for (const k of this.chunks.keys()) {
            if (this.chunks.size <= KEEP) break;
            if (!this.wanted.has(k)) this.chunks.delete(k);
          }
          this.loaded = new Map([...this.chunks].map(([k, v]) => [k, v.items]));
          this.arrivedAt = this.clock();
          for (const fn of this.listeners) fn();
        }
      })
      .finally(() => {
        if (this.inflight.get(c) === ac) this.inflight.delete(c);
        this.lanes.busy--;
        this.lanes.pump();
      });
  }

  /** A timer for the earliest backoff among the wanted chunks, so a still map heals without being moved. */
  private arm(wanted: ReadonlySet<ChunkKey>, now: number) {
    let at = Infinity;
    for (const [c, f] of this.failed) if (wanted.has(c) && f.at > now && f.at < at) at = f.at;
    if (this.holdUntil > now && this.queue.length) at = Math.min(at, this.holdUntil);
    if (at !== this.retryAt) this.schedule(at);
  }

  private schedule(at: number) {
    this.disarm();
    if (at === Infinity) return;
    this.retryAt = at;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.retryAt = Infinity;
        const l = this.last;
        if (l) this.want(l.box, l.key, l.ring);
      },
      Math.max(0, at - this.clock()),
    );
  }

  private disarm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.retryAt = Infinity;
  }

  /** One box's items (split into quarters while the answer is truncated). */
  private async load(box: Box, signal: AbortSignal): Promise<Result<T>> {
    let res: Response;
    let body: unknown;
    try {
      res = await this.fetchImpl(`${this.src.path}?x0=${box[0]}&z0=${box[1]}&x1=${box[2]}&z1=${box[3]}`, { credentials: "same-origin", signal });
      // Only a 404 before anything else answered means the agent has no such endpoint.
      if (res.status === 404) return this.answered ? LATER : "off";
      // A box the server refuses stays refused: nothing to draw there.
      if (res.status === 400) return [];
      if (!res.ok) {
        const after = Number(res.headers.get("Retry-After"));
        return res.status === 503 && after > 0 ? { wait: after * 1000 } : LATER;
      }
      // A page rather than an answer (an older server's SPA fallback) means none; a cut-off answer is asked again.
      if (!/json/i.test(res.headers.get("Content-Type") ?? "")) return this.answered ? LATER : "off";
      body = await res.json();
    } catch {
      // A dropped connection or a cut-off body is this chunk's problem, and passes.
      return signal.aborted ? "aborted" : LATER;
    }
    const items = this.src.decode(body);
    // Anything that is not an answer of this kind (an older server's SPA fallback) means none.
    if (!items) return this.answered ? LATER : "off";
    if (!signal.aborted) this.answered = true;
    if ((body as { truncated?: boolean }).truncated && box[2] - box[0] > MIN_SIDE) {
      const parts = await Promise.all(quarters(box).map((q) => this.load(q, signal)));
      if (parts.includes("aborted")) return "aborted";
      const failed = parts.find((p) => !Array.isArray(p));
      if (failed) return failed === "off" ? LATER : failed;
      return (parts as T[][]).flat();
    }
    return items.filter((p) => inBox(p.x, p.z, box));
  }
}

/** Floor plans, in 512 m chunks. */
export class PieceLoader extends ChunkLoader<Piece> {
  private flat: { of: ReadonlyMap<ChunkKey, readonly Piece[]>; pieces: readonly Piece[] } | null = null;

  constructor(fetchImpl?: typeof fetch, clock?: () => number, lanes?: Lanes) {
    super({ path: "/api/pieces", chunk: CHUNK, decode: decodePieces }, fetchImpl, clock, lanes);
  }

  /** Every loaded piece; a new array whenever a chunk arrives. */
  get pieces(): readonly Piece[] {
    if (this.flat?.of !== this.loaded) this.flat = { of: this.loaded, pieces: [...this.loaded.values()].flat() };
    return this.flat.pieces;
  }
}
