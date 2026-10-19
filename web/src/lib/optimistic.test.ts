import { describe, expect, it } from "vitest";
import { Optimistic } from "./optimistic";

interface Item {
  id: string;
  v: number;
  state: string;
}
type Result = { ok: true; item?: Item } | { ok: false; error: "stale"; item: Item } | { ok: false; error: "failed" };

/** A store like tasks and pins: server copies kept by version, the shown list with patches on top. */
function store(initial: Item[]) {
  const server = new Map(initial.map((i) => [i.id, i]));
  const frames: Item[][] = [];
  const put = (i: Item) => {
    const have = server.get(i.id);
    if (!have || have.v < i.v) server.set(i.id, i);
    show();
  };
  const show = () => frames.push([...server.values()].flatMap((i) => o.view(i.id, i) ?? []));
  const o: Optimistic<string, Item, Result> = new Optimistic<string, Item, Result>({ server: (id) => server.get(id), ok: (r) => r.ok, changed: show });
  const shown = () => frames.at(-1) ?? [...server.values()];
  const stateOf = (id: string) => shown().find((i) => i.id === id)?.state;
  return { o, server, put, frames, shown, stateOf };
}

/** A request the test answers by hand. */
function deferred() {
  let resolve!: (r: Result) => void;
  const promise = new Promise<Result>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Optimistic", () => {
  it("shows a change at once and keeps it through a successful answer, without a frame of the old copy", async () => {
    const s = store([{ id: "a", v: 1, state: "todo" }]);
    const req = deferred();
    const done = s.o.run("a", (i) => ({ ...i, state: "done" }), () => req.promise.then((r) => (r.ok && r.item && s.put(r.item), r)));
    expect(s.stateOf("a")).toBe("done");
    expect(s.o.pending("a")).toBe(true);
    await tick();
    req.resolve({ ok: true, item: { id: "a", v: 2, state: "done" } });
    expect(await done).toEqual({ ok: true, item: { id: "a", v: 2, state: "done" } });
    expect(s.o.pending("a")).toBe(false);
    expect(s.frames.every((f) => f[0]!.state === "done")).toBe(true);
    expect(s.shown()).toEqual([{ id: "a", v: 2, state: "done" }]);
  });

  it("rolls back to the server copy on a failure and keeps the failure", async () => {
    const s = store([{ id: "a", v: 1, state: "todo" }]);
    const done = s.o.run("a", (i) => ({ ...i, state: "done" }), async () => ({ ok: false, error: "failed" }) as const);
    expect(s.stateOf("a")).toBe("done");
    expect(await done).toEqual({ ok: false, error: "failed" });
    expect(s.stateOf("a")).toBe("todo");
    expect(s.o.pending("a")).toBe(false);
    expect(s.o.failure("a")).toEqual({ ok: false, error: "failed" });
    // The next change clears it.
    void s.o.run("a", (i) => i, async () => ({ ok: true }));
    expect(s.o.failure("a")).toBeUndefined();
  });

  it("rolls back when the request throws", async () => {
    const s = store([{ id: "a", v: 1, state: "todo" }]);
    await expect(s.o.run("a", (i) => ({ ...i, state: "done" }), async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(s.stateOf("a")).toBe("todo");
    expect(s.o.pending("a")).toBe(false);
  });

  it("on a 409 stale shows the server's copy, not this page's change", async () => {
    const s = store([{ id: "a", v: 1, state: "todo" }]);
    const theirs = { id: "a", v: 2, state: "doing" };
    const r = await s.o.run(
      "a",
      (i) => ({ ...i, state: "done" }),
      async () => {
        s.put(theirs);
        return { ok: false, error: "stale", item: theirs };
      },
    );
    expect(r).toMatchObject({ error: "stale" });
    expect(s.shown()).toEqual([theirs]);
    expect(s.o.failure("a")).toMatchObject({ error: "stale" });
  });

  it("a /live frame before the answer: no flicker, and the late answer changes nothing", async () => {
    const s = store([{ id: "a", v: 1, state: "todo" }]);
    const req = deferred();
    const done = s.o.run("a", (i) => ({ ...i, state: "done" }), () => req.promise.then((r) => (r.ok && r.item && s.put(r.item), r)));
    await tick();
    s.put({ id: "a", v: 2, state: "done" });
    expect(s.shown()).toEqual([{ id: "a", v: 2, state: "done" }]);
    req.resolve({ ok: true, item: { id: "a", v: 2, state: "done" } });
    await done;
    expect(s.shown()).toEqual([{ id: "a", v: 2, state: "done" }]);
    expect(s.frames.every((f) => f[0]!.state === "done")).toBe(true);
  });

  it("a /live frame after the answer is an equal copy and changes nothing", async () => {
    const s = store([{ id: "a", v: 1, state: "todo" }]);
    await s.o.run("a", (i) => ({ ...i, state: "done" }), async () => (s.put({ id: "a", v: 2, state: "done" }), { ok: true }));
    const before = s.frames.length;
    s.put({ id: "a", v: 2, state: "done" });
    expect(s.frames.slice(before).every((f) => f[0]!.state === "done")).toBe(true);
    expect(s.o.pending("a")).toBe(false);
  });

  it("someone else's change under a pending one shows with this page's change on top", async () => {
    const s = store([{ id: "a", v: 1, state: "todo" }]);
    const req = deferred();
    const done = s.o.run("a", (i) => ({ ...i, state: "done" }), () => req.promise);
    s.put({ id: "a", v: 2, state: "doing" });
    expect(s.shown()).toEqual([{ id: "a", v: 2, state: "done" }]);
    req.resolve({ ok: false, error: "failed" });
    await done;
    expect(s.shown()).toEqual([{ id: "a", v: 2, state: "doing" }]);
  });

  it("two quick taps: both show at once, and the second goes out after the first with the first's answer as its base", async () => {
    const s = store([{ id: "a", v: 1, state: "todo" }]);
    const bases: (Item | undefined)[] = [];
    const first = deferred();
    const second = deferred();
    const one = s.o.run("a", (i) => ({ ...i, state: "doing" }), (b) => (bases.push(b), first.promise.then((r) => (r.ok && r.item && s.put(r.item), r))));
    const two = s.o.run("a", (i) => ({ ...i, state: "done" }), (b) => (bases.push(b), second.promise.then((r) => (r.ok && r.item && s.put(r.item), r))));
    expect(s.stateOf("a")).toBe("done");
    await tick();
    expect(bases).toEqual([{ id: "a", v: 1, state: "todo" }]);
    first.resolve({ ok: true, item: { id: "a", v: 2, state: "doing" } });
    await one;
    await tick();
    // Still the second tap's state: the first answer does not pull the card back.
    expect(s.stateOf("a")).toBe("done");
    expect(bases).toEqual([
      { id: "a", v: 1, state: "todo" },
      { id: "a", v: 2, state: "doing" },
    ]);
    second.resolve({ ok: true, item: { id: "a", v: 3, state: "done" } });
    await two;
    expect(s.shown()).toEqual([{ id: "a", v: 3, state: "done" }]);
    expect(s.frames.slice(1).every((f) => f[0]!.state === "done")).toBe(true);
  });

  it("two quick taps where the first fails: both roll back and the second is never sent", async () => {
    const s = store([{ id: "a", v: 1, state: "todo" }]);
    let sent = 0;
    const one = s.o.run("a", (i) => ({ ...i, state: "doing" }), async (): Promise<Result> => (sent++, { ok: false, error: "failed" }));
    const two = s.o.run("a", (i) => ({ ...i, state: "done" }), async (): Promise<Result> => (sent++, { ok: true }));
    expect(await one).toEqual({ ok: false, error: "failed" });
    expect(await two).toEqual({ ok: false, error: "failed" });
    expect(sent).toBe(1);
    expect(s.stateOf("a")).toBe("todo");
    expect(s.o.pending("a")).toBe(false);
    // A new tap after the failure starts afresh.
    expect(await s.o.run("a", (i) => ({ ...i, state: "doing" }), async (): Promise<Result> => (sent++, { ok: true }))).toEqual({ ok: true });
    expect(sent).toBe(2);
  });

  it("a delete hides at once and comes back if refused", async () => {
    const s = store([
      { id: "a", v: 1, state: "todo" },
      { id: "b", v: 1, state: "todo" },
    ]);
    const req = deferred();
    const done = s.o.run("a", () => undefined, () => req.promise);
    expect(s.shown().map((i) => i.id)).toEqual(["b"]);
    req.resolve({ ok: false, error: "failed" });
    await done;
    expect(s.shown().map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("changes to different keys do not wait for each other", async () => {
    const s = store([
      { id: "a", v: 1, state: "todo" },
      { id: "b", v: 1, state: "todo" },
    ]);
    const slow = deferred();
    let bSent = false;
    void s.o.run("a", (i) => ({ ...i, state: "done" }), () => slow.promise);
    void s.o.run("b", (i) => ({ ...i, state: "done" }), async () => ((bSent = true), { ok: true }));
    await tick();
    expect(bSent).toBe(true);
    slow.resolve({ ok: true });
  });
});
