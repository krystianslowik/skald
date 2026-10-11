// Fetches floor plans for what the map shows, in aligned chunks, and keeps
// them per save: a pan over loaded chunks costs nothing, a new save asks
// again (the browser revalidates each chunk by its ETag, so an unchanged
// base is a 304). An agent without floor plans answers 404 once and is not
// asked again for that save.

import { chunkBox, chunksFor, decodePieces, inBox, quarters, type ChunkKey, type Piece } from "./pieces";

type Box = [number, number, number, number];

/** At most this many requests in flight. */
const PARALLEL = 3;
/** A truncated answer is split until boxes are this small. */
const MIN_SIDE = 64;

export class PieceLoader {
  /** Chunks loaded for the current save (or kept from the last one until refetched). */
  private chunks = new Map<ChunkKey, { key: string; pieces: Piece[] }>();
  private loading = new Set<ChunkKey>();
  private queue: ChunkKey[] = [];
  private key = "";
  /** The server has no floor plans for this save. */
  private off = false;
  private retryAt = 0;
  /** Every loaded piece; a new array whenever a chunk arrives. */
  pieces: readonly Piece[] = [];
  /** Called when pieces arrive. */
  onChange: (() => void) | null = null;

  constructor(
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
    const missing = chunksFor(box).filter((c) => this.chunks.get(c)?.key !== key && !this.loading.has(c));
    // Nearest first: the view's middle chunk before its corners.
    const mx = (box[0] + box[2]) / 2;
    const mz = (box[1] + box[3]) / 2;
    const dist = (c: ChunkKey) => {
      const b = chunkBox(c);
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
      void this.load(chunkBox(c))
        .then((pieces) => {
          if (pieces === "off") {
            this.off = true;
            this.queue = [];
          } else if (pieces === "later") {
            // Not built yet or unreachable: try again on a later settle.
            this.retryAt = this.clock() + 20_000;
            this.queue = [];
          } else if (key === this.key) {
            this.chunks.set(c, { key, pieces });
            this.pieces = [...this.chunks.values()].flatMap((x) => x.pieces);
            this.onChange?.();
          }
        })
        .finally(() => {
          this.loading.delete(c);
          this.pump();
        });
    }
  }

  /** One box's pieces (split into quarters while the answer is truncated). */
  private async load(box: Box): Promise<Piece[] | "off" | "later"> {
    let res: Response;
    try {
      res = await this.fetchImpl(`/api/pieces?x0=${box[0]}&z0=${box[1]}&x1=${box[2]}&z1=${box[3]}`, { credentials: "same-origin" });
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
    const pieces = decodePieces(body);
    // Anything that is not a floor plan (an older server's SPA fallback) means none.
    if (!pieces) return "off";
    if ((body as { truncated?: boolean }).truncated && box[2] - box[0] > MIN_SIDE) {
      const parts = await Promise.all(quarters(box).map((q) => this.load(q)));
      if (parts.some((p) => p === "off" || p === "later")) return parts.find((p) => typeof p === "string") as "off" | "later";
      return (parts as Piece[][]).flat();
    }
    return pieces.filter((p) => inBox(p.x, p.z, box));
  }
}
