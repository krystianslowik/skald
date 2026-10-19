// Optimistic changes for a store that keeps the server's copies (tasks, web
// pins). A change shows at once as a patch laid over the server copy, the
// request goes out, and the patch comes off when the answer is in:
//
// - success: the patch comes off with the HTTP answer. By then the answer is
//   the server copy (and a /live frame that came first already was), so
//   taking the patch off changes nothing on screen; a frame before the answer
//   only makes the patch a no-op, it does not end it;
// - failure, a 409 stale or no answer within `writeTimeout.ms`: the server
//   copy shows again, and the result is kept as the key's failure so the page
//   can say why.
//
// Changes to one key go out one at a time. Each is sent with the copy the
// viewer saw when they made it (the server's, with the changes still out on
// top), so its `expect` names what this page showed, and the change before it
// has reached the server by then. A failure drops the dependent changes still
// waiting behind it (a second status tap counted on the first) without sending
// them; an independent one (a confirmed delete) still goes.

/** How long a change may wait for its answer before it counts as failed (and the page stops waiting on it). */
export const writeTimeout = { ms: 15_000 };

/** A signal for one change's request: aborts after `writeTimeout.ms`. */
export const writeSignal = (): AbortSignal => AbortSignal.timeout(writeTimeout.ms);

interface Entry<V> {
  seq: number;
  /** Built on the changes before it: dropped unsent when one of those fails. */
  chained: boolean;
  /** The shown copy made from the one below it; undefined hides it (a delete). */
  apply: (v: V) => V | undefined;
}

interface Chain<V, R> {
  entries: Entry<V>[];
  /** Settles when the last queued send has. */
  tail: Promise<unknown>;
  seq: number;
  /** The last failure, and the newest entry queued when it came: chained entries up to it go unsent. */
  failed?: { upTo: number; result: R };
}

export interface OptimisticOptions<K, V, R> {
  /** The server's copy of a key now (an answer or a /live frame), or undefined. */
  server: (key: K) => V | undefined;
  /** Whether a result is a success. */
  ok: (result: R) => boolean;
  /** The patches or failures changed: the store shows its list again. */
  changed: () => void;
  /** The result for a request that threw: `run` never rejects. */
  thrown: (error: unknown) => R;
  /** The key is gone for good (deleted over /live): a failure about it is not kept. */
  gone?: (key: K) => boolean;
}

export interface RunOptions {
  /** False for a change that does not count on the ones before it (a delete): it is sent even if they fail. */
  chained?: boolean;
}

export class Optimistic<K, V, R> {
  private chains = new Map<K, Chain<V, R>>();
  private failures = new Map<K, R>();
  /** Results handed to changes that were dropped unsent: the same failure again, already reported once. */
  private repeats = new WeakSet<object>();

  constructor(private readonly o: OptimisticOptions<K, V, R>) {}

  /** What to show for a key: the server copy with the pending changes on top. */
  view(key: K, server: V | undefined): V | undefined {
    const chain = this.chains.get(key);
    let v = server;
    if (!chain) return v;
    for (const e of chain.entries) {
      if (v === undefined) return undefined;
      v = e.apply(v);
    }
    return v;
  }

  /** A change to this key is still out. */
  pending(key: K): boolean {
    return (this.chains.get(key)?.entries.length ?? 0) > 0;
  }

  /** Why the last change to this key failed, until the next change to it or `dismiss`. */
  failure(key: K): R | undefined {
    return this.failures.get(key);
  }

  /** A result a dropped change got: the failure of the change before it, reported there already. */
  repeated(result: R): boolean {
    return typeof result === "object" && result !== null && this.repeats.has(result);
  }

  /**
   * Forgets the key's failure (it has been seen, or the server's copy has
   * moved on). `quiet`: the caller shows its list again itself.
   */
  dismiss(key: K, quiet = false): void {
    if (this.failures.delete(key) && !quiet) this.o.changed();
  }

  /**
   * Shows `apply` at once and sends the change. `send` gets the copy the
   * viewer saw when making the change (undefined if the key was not shown).
   * The promise resolves with the result once the patch is off.
   */
  run(key: K, apply: (v: V) => V | undefined, send: (seen: V | undefined) => Promise<R>, opts: RunOptions = {}): Promise<R> {
    const seen = this.view(key, this.o.server(key));
    this.failures.delete(key);
    let chain = this.chains.get(key);
    if (!chain) {
      chain = { entries: [], tail: Promise.resolve(), seq: 0 };
      this.chains.set(key, chain);
    }
    const c = chain;
    const entry: Entry<V> = { seq: ++c.seq, chained: opts.chained ?? true, apply };
    c.entries.push(entry);
    this.o.changed();

    const settle = () => {
      if (c.entries.length === 0 && this.chains.get(key) === c) this.chains.delete(key);
    };
    const fail = (result: R) => {
      // The chained changes still waiting go with it: each counted on this one.
      c.failed = { upTo: c.seq, result };
      c.entries = c.entries.filter((e) => e !== entry && !(e.chained && e.seq <= c.seq));
      settle();
      if (!this.o.gone?.(key)) this.failures.set(key, result);
      this.o.changed();
    };

    const done = c.tail.then(async (): Promise<R> => {
      const f = c.failed;
      if (entry.chained && f && entry.seq <= f.upTo) {
        const again = typeof f.result === "object" && f.result !== null ? ({ ...f.result } as R) : f.result;
        if (typeof again === "object" && again !== null) this.repeats.add(again);
        return again;
      }
      let result: R;
      try {
        result = await send(seen);
      } catch (error) {
        result = this.o.thrown(error);
      }
      if (!this.o.ok(result)) {
        fail(result);
        return result;
      }
      c.entries = c.entries.filter((e) => e !== entry);
      settle();
      this.o.changed();
      return result;
    });
    c.tail = done;
    return done;
  }

  /** Tests: forget everything. */
  reset(): void {
    this.chains.clear();
    this.failures.clear();
  }
}
