import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { resetTasks, setTasks, type Task } from "../../lib/tasks";
import type { AgentEvent } from "../../types";
import { Saga } from "../Saga";
import { TaskBoard } from "./TaskBoard";

const inLocale = (ui: ReactElement, locale: "en" | "pl" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);

const task = (id: number, over: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  owner: "",
  status: "todo",
  note: "",
  target: null,
  materials: [],
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: `2026-10-19T10:00:0${id}.000Z`,
  doneAt: null,
  ...over,
});

const chest = (items: [string, number][]) => ({ id: "c", kind: "chest", prefab: "piece_chest_wood", x: 0, z: 0, width: 5, height: 2, items: items.map(([name, stack], i) => ({ name, stack, x: i, y: 0 })) });

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** /api/storage answers with `containers`; task writes answer with what the server would. */
function stubFetch(containers: ReturnType<typeof chest>[] | null) {
  const calls: Call[] = [];
  let nextId = 100;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, url, body });
      if (url === "/api/storage") {
        if (!containers) return new Response("{}", { status: 404 });
        return Response.json({ generation: 1, savedAt: "", showNames: false, containers });
      }
      if (url === "/api/tasks" && method === "GET") return Response.json({ tasks: [] });
      if (url === "/api/tasks" && method === "POST") return Response.json({ ok: true, task: task(nextId++, { ...(body as Partial<Task>), updatedAt: "2026-10-19T11:00:00.000Z" }) }, { status: 201 });
      const m = /^\/api\/tasks\/(\d+)$/.exec(url);
      if (m && method === "PATCH") return Response.json({ ok: true, task: task(Number(m[1]), { ...(body as Partial<Task>), updatedAt: "2026-10-19T11:00:00.000Z" }) });
      if (m && method === "DELETE") return Response.json({ ok: true });
      return new Response("{}", { status: 500 });
    }),
  );
  return calls;
}

beforeEach(() => resetTasks());
afterEach(() => vi.unstubAllGlobals());

describe("task board", () => {
  it("shows only what the stores still lack, and follows the stores and the live list", async () => {
    stubFetch([chest([["Stone", 3], ["Wood", 30], ["Copper", 6]])]);
    setTasks([task(1, { title: "Build a forge", owner: "Ragnar", status: "doing", materials: [{ item: "Stone", qty: 4 }, { item: "Coal", qty: 4 }, { item: "Wood", qty: 10 }, { item: "Copper", qty: 6 }] })]);
    inLocale(<TaskBoard saveKey="a" players={["Ragnar", "Freya"]} />);
    const missing = await screen.findByRole("list", { name: "Still missing" });
    expect(within(missing).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1Stone", "4Coal"]);
    expect(screen.getByText(/Doing/).parentElement).toHaveTextContent("Doing · Ragnar");

    // Another page adds a task: it arrives over the socket.
    act(() => setTasks([task(1, { title: "Build a forge", materials: [{ item: "Wood", qty: 10 }] }), task(2, { title: "Summon Eikthyr", target: { kind: "boss", key: "defeated_eikthyr" } })]));
    expect(screen.getByText("Summon Eikthyr")).toBeInTheDocument();
    expect(screen.getByText("for Eikthyr", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Everything is in the stores")).toBeInTheDocument();
  });

  it("moves a task on with one tap and keeps finished ones folded away", async () => {
    const calls = stubFetch([]);
    setTasks([task(1), task(2, { title: "Old one", status: "done", doneAt: "2026-10-18T10:00:00.000Z" })]);
    inLocale(<TaskBoard saveKey="a" players={[]} />);
    expect(screen.queryByText("Old one")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start Task 1" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", url: "/api/tasks/1", body: { status: "doing" } }));
    expect(await screen.findByRole("button", { name: "Mark Task 1 done" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done (1)" }));
    expect(screen.getByText("Old one")).toBeInTheDocument();
  });

  it("creates a task from a recipe, with the stores subtracted in the sheet", async () => {
    const calls = stubFetch([chest([["Stone", 20]])]);
    setTasks([]);
    inLocale(<TaskBoard saveKey="a" players={["Freya"]} />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "From a recipe" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Smelter" }));
    expect(within(sheet).getByLabelText("What")).toHaveValue("Smelter");
    await waitFor(() => expect(within(sheet).getByText("20 in the stores, 30 missing")).toBeInTheDocument());
    fireEvent.click(within(sheet).getByRole("button", { name: "Freya" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Add task" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ title: "Smelter", owner: "Freya", status: "todo", note: "", target: null, materials: [{ item: "Stone", qty: 50 }, { item: "SurtlingCore", qty: 5 }] }));
    expect(await screen.findByText("Smelter")).toBeInTheDocument();
  });

  it("will not save without a title", async () => {
    const calls = stubFetch([]);
    setTasks([]);
    inLocale(<TaskBoard saveKey="a" players={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Add task" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Give the task a name");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("asks twice before deleting", async () => {
    const calls = stubFetch([]);
    setTasks([task(3, { title: "Karve" })]);
    inLocale(<TaskBoard saveKey="a" players={[]} />);
    fireEvent.click(screen.getByText("Karve"));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(within(sheet).getByRole("button", { name: "Tap again to delete" }));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/tasks/3"));
    await waitFor(() => expect(screen.queryByText("Karve")).not.toBeInTheDocument());
  });

  it("speaks Polish", async () => {
    stubFetch(null);
    setTasks([task(1, { title: "Kuźnia", status: "doing", target: { kind: "base", name: "Przystań" }, materials: [{ item: "Coal", qty: 4 }] })]);
    inLocale(<TaskBoard saveKey="a" players={[]} />, "pl");
    expect(screen.getByRole("button", { name: "Nowe zadanie" })).toBeInTheDocument();
    expect(screen.getByText(/W toku/).parentElement).toHaveTextContent("W toku · w bazie Przystań");
    expect(await screen.findByText(/Ten serwer nie pokazuje zapasów/)).toBeInTheDocument();
  });
});

describe("finished tasks in the saga", () => {
  const ev = (data: Record<string, unknown>): AgentEvent => ({ seq: 1_000, ts: new Date().toISOString(), type: "task", data });

  it("get a line, with who did it when known", () => {
    inLocale(<Saga events={[ev({ title: "Forge", owner: "Bjorn" })]} />);
    expect(screen.getByText("Task done: Forge (Bjorn)")).toBeInTheDocument();
  });

  it("in Polish too, and none without a title", () => {
    inLocale(<Saga events={[ev({ title: "Kuźnia" }), { ...ev({}), seq: 2 }]} />, "pl");
    expect(screen.getByText("Zadanie zrobione: Kuźnia")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
