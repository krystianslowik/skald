// Optimistic changes for a store that keeps the server's copies (tasks, web
// pins). A change shows at once as a patch laid over the server copy, the
// request goes out, and the patch comes off when the answer is in:
//
// - success: the answer (or the /live frame, if it came first) is already the
//   server copy, so taking the patch off changes nothing on screen;
// - failure or a 409 stale: the server copy shows again, and the result is
//   kept as the key's failure so the page can say why.
//
// Changes to one key go out one at a time. Each is sent with the copy the
// viewer saw when they made it (the server's, with the changes still out on
// top), so its `expect` names what this page showed, and the change before it
// has reached the server by then. A failure drops the dependent changes still
// waiting behind it (a second status tap counted on the first) without sending
// them; an independent one (a confirmed delete) still goes.

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
  failed?: { upTo: number; outcome: { result: R } | { error: unknown } };
}

export interface OptimisticOptions<K, V, R> {
  /** The server's copy of a key now (an answer or a /live frame), or undefined. */
  server: (key: K) => V | undefined;
  /** Whether a result is a success. */
  ok: (result: R) => boolean;
  /** The patches or failures changed: the store shows its list again. */
  changed: () => void;
}

export interface RunOptions {
  /** False for a change that does not count on the ones before it (a delete): it is sent even if they fail. */
  chained?: boolean;
}

export class Optimistic<K, V, R> {
  private chains = new Map<K, Chain<V, R>>();
  private failures = new Map<K, R>();

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

  /** Forgets the key's failure (it has been seen, or the server's copy has moved on). */
  dismiss(key: K): void {
    if (this.failures.delete(key)) this.o.changed();
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
    const fail = (outcome: NonNullable<Chain<V, R>["failed"]>["outcome"]) => {
      // The chained changes still waiting go with it: each counted on this one.
      c.failed = { upTo: c.seq, outcome };
      c.entries = c.entries.filter((e) => e !== entry && !(e.chained && e.seq <= c.seq));
      settle();
      if ("result" in outcome) this.failures.set(key, outcome.result);
      this.o.changed();
    };

    const done = c.tail.then(async (): Promise<R> => {
      const f = c.failed;
      if (entry.chained && f && entry.seq <= f.upTo) {
        if ("result" in f.outcome) return f.outcome.result;
        throw f.outcome.error;
      }
      let result: R;
      try {
        result = await send(seen);
      } catch (error) {
        fail({ error });
        throw error;
      }
      if (!this.o.ok(result)) {
        fail({ result });
        return result;
      }
      c.entries = c.entries.filter((e) => e !== entry);
      settle();
      this.o.changed();
      return result;
    });
    c.tail = done.catch(() => undefined);
    return done;
  }

  /** Tests: forget everything. */
  reset(): void {
    this.chains.clear();
    this.failures.clear();
  }
}
