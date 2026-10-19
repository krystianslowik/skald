// Optimistic changes for a store that keeps the server's copies (tasks, web
// pins). A change shows at once as a patch laid over the server copy, the
// request goes out, and the patch comes off when the answer is in:
//
// - success: the answer (or the /live frame, if it came first) is already the
//   server copy, so taking the patch off changes nothing on screen;
// - failure or a 409 stale: the server copy shows again, and the result is
//   kept as the key's failure so the page can say why.
//
// Changes to one key go out one at a time: each is sent with the server copy
// as it is when its turn comes (so its `expect` names what the server has after
// the change before it), and a failure drops the ones still waiting behind it
// without sending them.

interface Patch<V> {
  /** The shown copy made from the one below it; undefined hides it (a delete). */
  apply: (v: V) => V | undefined;
}

interface Chain<V, R> {
  patches: Patch<V>[];
  /** Settles when the last queued send has. */
  tail: Promise<unknown>;
  /** The failure that ended this chain; the changes still waiting resolve with it unsent. */
  failed?: { result: R } | { error: unknown };
}

export interface OptimisticOptions<K, V, R> {
  /** The server's copy of a key now (an answer or a /live frame), or undefined. */
  server: (key: K) => V | undefined;
  /** Whether a result is a success. */
  ok: (result: R) => boolean;
  /** The patches or failures changed: the store shows its list again. */
  changed: () => void;
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
    for (const p of chain.patches) {
      if (v === undefined) return undefined;
      v = p.apply(v);
    }
    return v;
  }

  /** A change to this key is still out. */
  pending(key: K): boolean {
    return (this.chains.get(key)?.patches.length ?? 0) > 0;
  }

  /** Why the last change to this key failed, until the next change to it. */
  failure(key: K): R | undefined {
    return this.failures.get(key);
  }

  /**
   * Shows `apply` at once and sends the change. `send` gets the server copy
   * as it is when this change's turn comes. The promise resolves with the
   * result once the patch is off.
   */
  run(key: K, apply: (v: V) => V | undefined, send: (base: V | undefined) => Promise<R>): Promise<R> {
    this.failures.delete(key);
    let chain = this.chains.get(key);
    if (!chain) {
      chain = { patches: [], tail: Promise.resolve() };
      this.chains.set(key, chain);
    }
    const c = chain;
    const patch: Patch<V> = { apply };
    c.patches.push(patch);
    this.o.changed();

    const fail = (f: NonNullable<Chain<V, R>["failed"]>) => {
      // Every change still waiting goes with it: each counted on the one before.
      c.failed = f;
      c.patches = [];
      if (this.chains.get(key) === c) this.chains.delete(key);
      if ("result" in f) this.failures.set(key, f.result);
      this.o.changed();
    };

    const done = c.tail.then(async (): Promise<R> => {
      if (c.failed) {
        if ("result" in c.failed) return c.failed.result;
        throw c.failed.error;
      }
      let result: R;
      try {
        result = await send(this.o.server(key));
      } catch (error) {
        fail({ error });
        throw error;
      }
      if (!this.o.ok(result)) {
        fail({ result });
        return result;
      }
      c.patches = c.patches.filter((p) => p !== patch);
      if (c.patches.length === 0 && this.chains.get(key) === c) this.chains.delete(key);
      this.o.changed();
      return result;
    });
    c.tail = done.catch(() => undefined);
    return done;
  }

  /** Forgets the key's failure once the page has shown it. */
  dismiss(key: K): void {
    if (this.failures.delete(key)) this.o.changed();
  }

  /** Tests: forget everything. */
  reset(): void {
    this.chains.clear();
    this.failures.clear();
  }
}
