// Fetches what the map draws at close zoom (floor plans, nature) in aligned
// chunks, and keeps them per save: a pan over loaded chunks costs nothing, a
// new save asks again (the browser revalidates each chunk by its ETag, so an
// unchanged chunk is a 304). An agent without the endpoint answers 404 once
// and is not asked again for that save.

import { CHUNK, chunkBox, chunksFor, decodePieces, inBox, quarters, type ChunkKey, type Piece } from "./pieces";

type Box = [number, number, number, number];

/** At most this many requests in flight. */
const PARALLEL = 3;
/** A truncated answer is split until boxes are this small. */
const MIN_SIDE = 64;

export interface ChunkSource<T> {
  /** The API path, without the query. */
  path: string;
  /** Chunk side in metres. */
  chunk: number;
  /** The answer's items, or null when it is not one (an older server, a proxy page). */
  decode: (body: unknown) => T[] | null;
}

export class ChunkLoader<T extends { x: number; z: number }> {
  /** Chunks loaded for the current save (or kept from the last one until refetched). */
  private chunks = new Map<ChunkKey, { key: string; items: T[] }>();
  private loading = new Set<ChunkKey>();
  private queue: ChunkKey[] = [];
  private key = "";
  /** The server has none of this for this save. */
  private off = false;
  private retryAt = 0;
  /** Every loaded chunk's items; a new map whenever a chunk arrives. */
  loaded: ReadonlyMap<ChunkKey, readonly T[]> = new Map();
  /** Called when a chunk arrives. */
  onChange: (() => void) | null = null;

  constructor(
    private readonly src: ChunkSource<T>,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly clock: () => number = Date.now,
  ) {}

  /** Asks for the chunks `box` touches, for save `key`; those already loaded for it are skipped. */
  want(box: readonly [number, number, number, number], key: string): void {
    if (key !== this.key) {
      this.key = key;
      this.off = false;
      this.retryAt = 0;
      this.queue = [];
    }
    if (this.off || this.clock() < this.retryAt) return;
    const size = this.src.chunk;
    const missing = chunksFor(box, size).filter((c) => this.chunks.get(c)?.key !== key && !this.loading.has(c));
    // Nearest first: the view's middle chunk before its corners.
    const mx = (box[0] + box[2]) / 2;
    const mz = (box[1] + box[3]) / 2;
    const dist = (c: ChunkKey) => {
      const b = chunkBox(c, size);
      return Math.hypot((b[0] + b[2]) / 2 - mx, (b[1] + b[3]) / 2 - mz);
    };
    this.queue = [...new Set([...missing.sort((a, b) => dist(a) - dist(b)), ...this.queue])];
    this.pump();
  }

  private pump() {
    while (this.loading.size < PARALLEL && this.queue.length && !this.off) {
      const c = this.queue.shift()!;
      if (this.chunks.get(c)?.key === this.key || this.loading.has(c)) continue;
      this.loading.add(c);
      const key = this.key;
      void this.load(chunkBox(c, this.src.chunk))
        .then((items) => {
          if (items === "off") {
            this.off = true;
            this.queue = [];
          } else if (items === "later") {
            // Not built yet or unreachable: try again on a later settle.
            this.retryAt = this.clock() + 20_000;
            this.queue = [];
          } else if (key === this.key) {
            this.chunks.set(c, { key, items });
            this.loaded = new Map([...this.chunks].map(([k, v]) => [k, v.items]));
            this.onChange?.();
          }
        })
        .finally(() => {
          this.loading.delete(c);
          this.pump();
        });
    }
  }

  /** One box's items (split into quarters while the answer is truncated). */
  private async load(box: Box): Promise<T[] | "off" | "later"> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.src.path}?x0=${box[0]}&z0=${box[1]}&x1=${box[2]}&z1=${box[3]}`, { credentials: "same-origin" });
    } catch {
      return "later";
    }
    if (res.status === 404 || res.status === 400) return "off";
    if (!res.ok) return "later";
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return "off";
    }
    const items = this.src.decode(body);
    // Anything that is not an answer of this kind (an older server's SPA fallback) means none.
    if (!items) return "off";
    if ((body as { truncated?: boolean }).truncated && box[2] - box[0] > MIN_SIDE) {
      const parts = await Promise.all(quarters(box).map((q) => this.load(q)));
      if (parts.some((p) => p === "off" || p === "later")) return parts.find((p) => typeof p === "string") as "off" | "later";
      return (parts as T[][]).flat();
    }
    return items.filter((p) => inBox(p.x, p.z, box));
  }
}

/** Floor plans, in 512 m chunks. */
export class PieceLoader extends ChunkLoader<Piece> {
  private flat: { of: ReadonlyMap<ChunkKey, readonly Piece[]>; pieces: readonly Piece[] } | null = null;

  constructor(fetchImpl?: typeof fetch, clock?: () => number) {
    super({ path: "/api/pieces", chunk: CHUNK, decode: decodePieces }, fetchImpl, clock);
  }

  /** Every loaded piece; a new array whenever a chunk arrives. */
  get pieces(): readonly Piece[] {
    if (this.flat?.of !== this.loaded) this.flat = { of: this.loaded, pieces: [...this.loaded.values()].flat() };
    return this.flat.pieces;
  }
}
