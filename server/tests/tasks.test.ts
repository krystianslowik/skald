import { describe, expect, it, spyOn } from "bun:test";
import { RateLimiter } from "../src/auth";
import { Hono } from "hono";
import type { AgentSource } from "../src/agent";
import { createApp } from "../src/app";
import { HistoryStore } from "../src/db";
import { Hub } from "../src/hub";
import { silentLog } from "../src/log";
import { liveSocket, liveSocketData, type LiveSocketData } from "../src/live";
import { expandRecipe, RECIPES } from "../src/recipes";
import { parseTaskInput, shortfall, stillMissing, stockTotals, TASK_LIMITS, type Task } from "../src/taskmodel";
import { doneEvent, mountTasks } from "../src/taskroutes";
import { TaskStore } from "../src/tasks";
import type { LiveMessage, LiveWireMessage } from "../src/types";

const chest = (items: [string, number][]) => ({ items: items.map(([name, stack]) => ({ name, stack })) });

describe("shortfall", () => {
  const stock = stockTotals([chest([["Wood", 30], ["Stone", 2]]), chest([["Stone", 1], ["Copper", 6]]), chest([])]);

  it("adds every container's stacks per item", () => {
    expect(Object.fromEntries(stock)).toEqual({ Wood: 30, Stone: 3, Copper: 6 });
  });

  it("subtracts what the stores hold and never goes below zero", () => {
    const forge = RECIPES.find((r) => r.id === "forge")!;
    expect(shortfall(forge.materials, stock)).toEqual([
      { item: "Stone", qty: 4, have: 3, missing: 1 },
      { item: "Coal", qty: 4, have: 0, missing: 4 },
      { item: "Wood", qty: 10, have: 30, missing: 0 },
      { item: "Copper", qty: 6, have: 6, missing: 0 },
    ]);
  });

  it("lists only what is still missing", () => {
    const needs = shortfall([{ item: "Wood", qty: 40 }, { item: "Copper", qty: 1 }], stock);
    expect(stillMissing(needs)).toEqual([{ item: "Wood", qty: 40, have: 30, missing: 10 }]);
  });

  it("follows the stores when they change", () => {
    const list = [{ item: "Coal", qty: 4 }];
    expect(stillMissing(shortfall(list, stockTotals([chest([["Coal", 1]])])))[0]!.missing).toBe(3);
    expect(stillMissing(shortfall(list, stockTotals([chest([["Coal", 1]]), chest([["Coal", 3]])])))).toEqual([]);
  });

  it("holds each task against the whole stock on its own", () => {
    const a = shortfall([{ item: "Wood", qty: 20 }], stock);
    const b = shortfall([{ item: "Wood", qty: 20 }], stock);
    expect(a[0]!.missing).toBe(0);
    expect(b[0]!.missing).toBe(0);
  });

  it("with empty stores everything is missing", () => {
    expect(shortfall([{ item: "Tin", qty: 10 }], new Map())).toEqual([{ item: "Tin", qty: 10, have: 0, missing: 10 }]);
  });
});

describe("recipes", () => {
  it("expand into the list, adding up items already there", () => {
    const smelter = RECIPES.find((r) => r.id === "smelter")!;
    expect(expandRecipe([{ item: "Stone", qty: 5 }, { item: "Wood", qty: 1 }], smelter)).toEqual([
      { item: "Stone", qty: 55 },
      { item: "Wood", qty: 1 },
      { item: "SurtlingCore", qty: 5 },
    ]);
    expect(expandRecipe([], smelter, 2)).toEqual([
      { item: "Stone", qty: 100 },
      { item: "SurtlingCore", qty: 10 },
    ]);
  });

  it("are unique, valid task material lists, and offerings point at their boss", () => {
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    for (const r of RECIPES) {
      expect(parseTaskInput({ title: r.id, materials: r.materials, target: r.target ?? null }, false).ok).toBe(true);
      if (r.kind === "offering") expect(r.target).toEqual({ kind: "boss", key: r.id });
    }
  });
});

describe("parseTaskInput", () => {
  it("needs a title on create, trims, and keeps only known fields", () => {
    expect(parseTaskInput({}, false)).toEqual({ ok: false, error: "title" });
    expect(parseTaskInput({ title: "   " }, false)).toEqual({ ok: false, error: "title" });
    expect(parseTaskInput({ title: " Forge ", extra: 1 }, false)).toEqual({ ok: true, value: { title: "Forge" } });
    expect(parseTaskInput({ status: "doing" }, true)).toEqual({ ok: true, value: { status: "doing" } });
  });

  it("refuses bad values by field", () => {
    expect(parseTaskInput({ title: "x".repeat(TASK_LIMITS.title + 1) }, false)).toEqual({ ok: false, error: "title" });
    expect(parseTaskInput({ title: "a\u0000b" }, false)).toEqual({ ok: false, error: "title" });
    expect(parseTaskInput({ status: "later" }, true)).toEqual({ ok: false, error: "status" });
    expect(parseTaskInput({ owner: 3 }, true)).toEqual({ ok: false, error: "owner" });
    expect(parseTaskInput({ target: { kind: "boss", key: "eikthyr" } }, true)).toEqual({ ok: false, error: "target" });
    expect(parseTaskInput({ target: { kind: "base", name: "" } }, true)).toEqual({ ok: false, error: "target" });
    expect(parseTaskInput({ materials: [{ item: "../x", qty: 1 }] }, true)).toEqual({ ok: false, error: "materials" });
    expect(parseTaskInput({ materials: [{ item: "Wood", qty: 0 }] }, true)).toEqual({ ok: false, error: "materials" });
    expect(parseTaskInput({ materials: [{ item: "Wood", qty: 1.5 }] }, true)).toEqual({ ok: false, error: "materials" });
    const many = Array.from({ length: TASK_LIMITS.materials + 1 }, (_, i) => ({ item: `Item${i}`, qty: 1 }));
    expect(parseTaskInput({ materials: many }, true)).toEqual({ ok: false, error: "materials" });
    expect(parseTaskInput([], true)).toEqual({ ok: false, error: "body" });
  });

  it("takes tabs pasted from a table as spaces", () => {
    expect(parseTaskInput({ title: "Forge\tnow", note: "Wood\t10\nStone\t4" }, false)).toEqual({ ok: true, value: { title: "Forge now", note: "Wood 10\nStone 4" } });
  });

  it("keeps newlines in a note, merges repeated materials, and takes a null target", () => {
    const r = parseTaskInput({ title: "Ship", note: "keel first\nthen sail", target: null, materials: [{ item: "Wood", qty: 2 }, { item: "Resin", qty: 1 }, { item: "Wood", qty: 3 }] }, false);
    expect(r).toEqual({ ok: true, value: { title: "Ship", note: "keel first\nthen sail", target: null, materials: [{ item: "Wood", qty: 5 }, { item: "Resin", qty: 1 }] } });
    expect(parseTaskInput({ target: { kind: "base", name: "Longhouse" } }, true)).toEqual({ ok: true, value: { target: { kind: "base", name: "Longhouse" } } });
  });
});

describe("TaskStore", () => {
  it("creates, edits, completes, reopens and removes, telling listeners each time", () => {
    let t = Date.parse("2026-10-19T10:00:00Z");
    const store = new TaskStore(":memory:", () => t);
    const seen: Task[][] = [];
    store.subscribe(() => seen.push(store.list()));

    const made = store.create({ title: "Forge", owner: "Ragnar" });
    expect(made.ok && made.task).toMatchObject({ id: 1, title: "Forge", owner: "Ragnar", status: "todo", note: "", target: null, materials: [], doneAt: null });
    t += 1000;
    const doing = store.update(1, { status: "doing", materials: [{ item: "Copper", qty: 6 }] });
    expect(doing.ok && doing.completed).toBe(false);
    t += 1000;
    const done = store.update(1, { status: "done" });
    expect(done.ok && done.completed).toBe(true);
    expect(done.ok && done.task.doneAt).toBe("2026-10-19T10:00:02.000Z");
    // Editing a finished task does not finish it again.
    const again = store.update(1, { note: "built by the river", status: "done" });
    expect(again.ok && again.completed).toBe(false);
    const reopened = store.update(1, { status: "todo" });
    expect(reopened.ok && reopened.task.doneAt).toBeNull();
    // Finished again: done, but the saga already has its line.
    const twice = store.update(1, { status: "done" });
    expect(twice.ok && twice.task.status).toBe("done");
    expect(twice.ok && twice.completed).toBe(false);
    store.update(1, { status: "todo" });
    expect(store.update(9, { title: "x" })).toEqual({ ok: false, error: "not_found" });

    expect(store.remove(1)).toBe(true);
    expect(store.remove(1)).toBe(false);
    expect(store.list()).toEqual([]);
    expect(seen.map((l) => l.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 0]);
    expect(seen[1]![0]!.materials).toEqual([{ item: "Copper", qty: 6 }]);
  });

  it("keeps tasks across a restart", async () => {
    const path = `${import.meta.dir}/.tasks-${process.pid}.db`;
    try {
      const a = new TaskStore(path);
      a.create({ title: "Karve", materials: [{ item: "FineWood", qty: 30 }], target: { kind: "base", name: "Harbour" } });
      a.update(1, { status: "done" });
      a.update(1, { status: "todo" });
      a.close();
      const b = new TaskStore(path);
      expect(b.list()).toMatchObject([{ id: 1, title: "Karve", materials: [{ item: "FineWood", qty: 30 }], target: { kind: "base", name: "Harbour" } }]);
      // The saga line is remembered across the restart, and never sent.
      expect("logged" in b.list()[0]!).toBe(false);
      const again = b.update(1, { status: "done" });
      expect(again.ok && again.completed).toBe(false);
      b.close();
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) await Bun.file(f).delete().catch(() => {});
    }
  });

  it("refuses a task past the limit", () => {
    const store = new TaskStore(":memory:");
    for (let i = 0; i < TASK_LIMITS.tasks; i++) expect(store.create({ title: `t${i}` }).ok).toBe(true);
    expect(store.create({ title: "one more" })).toEqual({ ok: false, error: "too_many" });
  });

  it("shares the file with the history store", async () => {
    const path = `${import.meta.dir}/.shared-${process.pid}.db`;
    try {
      const history = new HistoryStore(path);
      const tasks = new TaskStore(path);
      history.insert("e", { seq: 1, ts: "2026-10-19T10:00:00Z", type: "death", data: { name: "Bjorn" } });
      tasks.create({ title: "Bury the dead" });
      expect(history.count()).toBe(1);
      expect(tasks.list()).toHaveLength(1);
      history.close();
      tasks.close();
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) await Bun.file(f).delete().catch(() => {});
    }
  });
});

describe("/api/tasks", () => {
  const setup = () => {
    const store = new TaskStore(":memory:");
    const done: Task[] = [];
    const app = new Hono();
    mountTasks(app, { store, onDone: (t) => done.push(t) });
    const send = (method: string, path: string, body?: unknown, type = "application/json") =>
      app.request(path, { method, headers: body === undefined ? {} : { "Content-Type": type }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { store, done, send };
  };

  it("creates, lists, edits and deletes", async () => {
    const { send, done } = setup();
    const created = await send("POST", "/api/tasks", { title: "Smelter", owner: "Freya", materials: [{ item: "Stone", qty: 50 }] });
    expect(created.status).toBe(201);
    const { task } = (await created.json()) as { task: Task };
    expect(task).toMatchObject({ id: 1, title: "Smelter", owner: "Freya", status: "todo" });

    const list = (await (await send("GET", "/api/tasks")).json()) as { tasks: Task[] };
    expect(list.tasks.map((t) => t.title)).toEqual(["Smelter"]);

    const patched = await send("PATCH", "/api/tasks/1", { status: "done" });
    expect(patched.status).toBe(200);
    expect(done.map((t) => t.title)).toEqual(["Smelter"]);

    expect((await send("DELETE", "/api/tasks/1")).status).toBe(200);
    expect((await send("DELETE", "/api/tasks/1")).status).toBe(404);
  });

  it("refuses bad input, unknown ids and non-JSON bodies", async () => {
    const { send } = setup();
    const bad = await send("POST", "/api/tasks", { title: "" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: "invalid", field: "title" });
    expect((await send("POST", "/api/tasks", "title=x", "application/x-www-form-urlencoded")).status).toBe(415);
    expect((await send("POST", "/api/tasks", "{nope")).status).toBe(400);
    expect((await send("POST", "/api/tasks", { title: "x", note: "y".repeat(20_000) })).status).toBe(413);
    expect((await send("PATCH", "/api/tasks/7", { title: "x" })).status).toBe(404);
    expect((await send("PATCH", "/api/tasks/abc", { title: "x" })).status).toBe(404);
    expect((await send("DELETE", "/api/tasks/-1")).status).toBe(404);
  });

  it("answers 409 when the board is full", async () => {
    const { store, send } = setup();
    for (let i = 0; i < TASK_LIMITS.tasks; i++) store.create({ title: `t${i}` });
    const res = await send("POST", "/api/tasks", { title: "one more" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "too_many" });
  });

  it("is behind the panel sign-in but needs no admin session", async () => {
    const hub = new Hub({} as AgentSource, new HistoryStore(":memory:"));
    const store = new TaskStore(":memory:");
    const app = createApp({
      sessionSecret: "secret",
      passwordHash: await Bun.password.hash("ognisko"),
      adminPasswordHash: await Bun.password.hash("jarl"),
      secureCookie: false,
      agent: {} as AgentSource,
      hub,
      metrics: async () => null,
      tasks: { store },
      log: silentLog,
    });
    expect((await app.request("/api/tasks")).status).toBe(401);
    const login = await app.request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "ognisko" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const res = await app.request("/api/tasks", { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Mead" }) });
    expect(res.status).toBe(201);
    // A page on another site cannot change the board.
    const cross = await app.request("http://panel.example/api/tasks", { method: "POST", headers: { cookie, "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ title: "x" }) });
    expect(cross.status).toBe(403);
  });
});

describe("tasks over /live and in the saga", () => {
  class FakeSocket {
    sent: LiveWireMessage[] = [];
    constructor(public data: LiveSocketData) {}
    send(s: string) {
      this.sent.push(JSON.parse(s) as LiveWireMessage);
    }
    tasks() {
      return this.sent.flatMap((m) => (m.type === "tasks" ? [`list:${m.tasks.map((t) => t.title).join(",")}`] : m.type === "task" ? [`put:${m.task.title}`] : m.type === "task_gone" ? [`gone:${m.id}`] : []));
    }
  }

  it("sends the list when a socket opens, then each change as one task, to every socket", () => {
    const hub = new Hub({} as AgentSource, new HistoryStore(":memory:"));
    const store = new TaskStore(":memory:");
    store.create({ title: "Forge" });
    const live = liveSocket(hub, store);
    const a = new FakeSocket(liveSocketData(new URL("http://x/live?topics=")));
    const b = new FakeSocket(liveSocketData(new URL("http://x/live?topics=")));
    live.open(a);
    live.open(b);
    store.create({ title: "Smelter" });
    live.close(b);
    store.remove(1);
    expect(a.tasks()).toEqual(["list:Forge", "put:Smelter", "gone:1"]);
    expect(b.tasks()).toEqual(["list:Forge", "put:Smelter"]);
  });

  it("stores a finished task as a saga event apart from the agent's sequence", () => {
    let t = Date.parse("2026-10-19T12:00:00Z");
    const history = new HistoryStore(":memory:");
    const hub = new Hub({} as AgentSource, history, { clock: () => t });
    const got: LiveMessage[] = [];
    hub.subscribe((m) => got.push(m));
    hub.record("task", doneEvent({ title: "Karve", owner: "Astrid" } as Task));
    hub.record("task", doneEvent({ title: "Karve", owner: "" } as Task));
    expect(got).toEqual([
      { type: "event", stored: true, event: { seq: -1, ts: "2026-10-19T12:00:00.000Z", type: "task", data: { title: "Karve", owner: "Astrid" } } },
      { type: "event", stored: true, event: { seq: -2, ts: "2026-10-19T12:00:00.000Z", type: "task", data: { title: "Karve" } } },
    ]);
    expect(hub.history().events.map((e) => e.type)).toEqual(["task", "task"]);
    // The agent's own stream still starts from 1 and is not deduped against these.
    hub.ingest("agent-epoch", { seq: 1, ts: "2026-10-19T12:00:01Z", type: "death", data: { name: "Bjorn" } });
    expect(history.count()).toBe(3);
  });

  it("numbers panel events below zero, so no agent seq comparison ever picks one (restore progress takes the newest seq)", async () => {
    const path = `${import.meta.dir}/.seq-${process.pid}.db`;
    try {
      let history = new HistoryStore(path);
      let hub = new Hub({} as AgentSource, history);
      hub.ingest("agent-epoch", { seq: 7, ts: "2026-10-19T12:00:00Z", type: "admin", data: { command: "restore", step: "begin", result: "ok" } });
      hub.record("task", { title: "Forge" });
      hub.record("task", { title: "Smelter" });
      expect(Math.max(...hub.history().events.map((e) => e.seq))).toBe(7);
      history.close();
      // After a restart the count goes on below the lowest stored one.
      history = new HistoryStore(path);
      hub = new Hub({} as AgentSource, history);
      const got: LiveMessage[] = [];
      hub.subscribe((m) => got.push(m));
      hub.record("task", { title: "Karve" });
      expect(got[0]!.type === "event" && got[0]!.event.seq).toBe(-3);
      expect(history.count()).toBe(4);
      history.close();
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) await Bun.file(f).delete().catch(() => {});
    }
  });

  it("keeps only the newest task lines, so tasks cannot crowd the saga", () => {
    const history = new HistoryStore(":memory:");
    const hub = new Hub({} as AgentSource, history);
    hub.ingest("agent-epoch", { seq: 1, ts: "2026-10-19T12:00:00Z", type: "death", data: { name: "Bjorn" } });
    for (let i = 0; i < Hub.TASK_LINES + 5; i++) hub.record("task", { title: `t${i}` });
    const events = hub.history().events;
    expect(events.filter((e) => e.type === "task")).toHaveLength(Hub.TASK_LINES);
    expect(events.some((e) => e.type === "death")).toBe(true);
    expect(events.find((e) => e.type === "task")!.data.title).toBe(`t${Hub.TASK_LINES + 4}`);
  });

  it("serialises a change once, whatever the number of sockets", () => {
    const hub = new Hub({} as AgentSource, new HistoryStore(":memory:"));
    const store = new TaskStore(":memory:");
    const live = liveSocket(hub, store);
    const socks = [0, 1, 2].map(() => new FakeSocket(liveSocketData(new URL("http://x/live?topics="))));
    for (const s of socks) live.open(s);
    const spy = spyOn(JSON, "stringify");
    try {
      store.create({ title: "Forge" });
      const frames = spy.mock.calls.filter(([v]) => (v as { type?: string })?.type === "task");
      expect(frames).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    for (const s of socks) expect(s.tasks()).toEqual(["list:", "put:Forge"]);
    // Sockets opening between changes share one serialised list.
    const spy2 = spyOn(JSON, "stringify");
    try {
      for (let i = 0; i < 3; i++) live.open(new FakeSocket(liveSocketData(new URL("http://x/live?topics="))));
      expect(spy2.mock.calls.filter(([v]) => (v as { type?: string })?.type === "tasks")).toHaveLength(1);
    } finally {
      spy2.mockRestore();
    }
  });
});

describe("conflicts and limits", () => {
  it("refuses a status, owner or material change made on a value that moved on, and nothing else", () => {
    const store = new TaskStore(":memory:");
    store.create({ title: "Forge", materials: [{ item: "Copper", qty: 6 }] });
    expect(store.get(1)!.rev).toBe(0);
    expect(store.update(1, { status: "doing" }, { status: "todo" }).ok).toBe(true);
    expect(store.get(1)!.rev).toBe(1);
    // A page that still saw "todo":
    expect(store.update(1, { status: "done" }, { status: "todo" })).toMatchObject({ ok: false, error: "stale", task: { rev: 1, status: "doing" } });
    expect(store.update(1, { materials: [] }, { materials: [{ item: "Copper", qty: 5 }] })).toMatchObject({ ok: false, error: "stale" });
    // Two players claiming the same task: the second is told.
    expect(store.update(1, { owner: "Astrid" }, { owner: "" }).ok).toBe(true);
    expect(store.update(1, { owner: "Bjorn" }, { owner: "" })).toMatchObject({ ok: false, error: "stale", task: { owner: "Astrid" } });
    // Both making the same move is no clash either.
    expect(store.update(1, { owner: "Astrid" }, { owner: "" }).ok).toBe(true);
    // Someone else's note edit is no conflict for a status change.
    expect(store.update(1, { note: "by the river" }).ok).toBe(true);
    expect(store.update(1, { status: "done" }, { status: "doing" }).ok).toBe(true);
  });

  it("does not lose a saga line when the write fails", () => {
    const store = new TaskStore(":memory:");
    store.create({ title: "Forge" });
    const db = (store as unknown as { db: { query: (sql: string) => unknown } }).db;
    const real = db.query.bind(db);
    let fail = true;
    const spy = spyOn(db, "query").mockImplementation((sql: string) => {
      if (fail && sql.startsWith("UPDATE")) {
        fail = false;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return real(sql);
    });
    expect(() => store.update(1, { status: "done" })).toThrow();
    const retry = store.update(1, { status: "done" });
    expect(retry.ok && retry.completed).toBe(true);
    spy.mockRestore();
  });

  it("gives no saga line for a task created already done", () => {
    const store = new TaskStore(":memory:");
    const made = store.create({ title: "Old work", status: "done" });
    expect(made.ok && made.completed).toBe(false);
    store.update(1, { status: "todo" });
    const again = store.update(1, { status: "done" });
    expect(again.ok && again.completed).toBe(false);
  });

  it("keeps a schema version for the table, and shares the history store's connection", () => {
    const history = new HistoryStore(":memory:");
    const store = new TaskStore(history.connection);
    expect(store.schemaVersion()).toBe(1);
    store.create({ title: "Forge" });
    expect((history.connection.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(1);
    expect(history.getMeta("tasks.schema")).toBe("1");
    // The connection stays the history store's.
    store.close();
    expect(history.count()).toBe(0);
  });

  const app = (over: Partial<Parameters<typeof mountTasks>[1]> = {}) => {
    const store = new TaskStore(":memory:");
    const a = new Hono();
    mountTasks(a, { store, ...over });
    const send = (method: string, path: string, body?: unknown) =>
      a.request(path, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { store, send };
  };

  it("answers 409 with the current task when an edit is stale", async () => {
    const { send } = app();
    await send("POST", "/api/tasks", { title: "Forge" });
    await send("PATCH", "/api/tasks/1", { status: "doing", expect: { status: "todo" } });
    const res = await send("PATCH", "/api/tasks/1", { status: "done", expect: { status: "todo" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: "stale", task: { status: "doing", rev: 1 } });
    expect((await send("PATCH", "/api/tasks/1", { status: "done", expect: { status: "later" } })).status).toBe(400);
    expect((await send("PATCH", "/api/tasks/1", { status: "done", expect: "x" })).status).toBe(400);
  });

  it("limits writes per client", async () => {
    const { send } = app({ limiter: new RateLimiter(3, 60_000, 60_000), clientKey: () => "203.0.113.7" });
    for (let i = 0; i < 3; i++) expect((await send("POST", "/api/tasks", { title: `t${i}` })).status).toBe(201);
    const res = await send("POST", "/api/tasks", { title: "one too many" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    // Reading is never limited.
    expect((await send("GET", "/api/tasks")).status).toBe(200);
  });
});

