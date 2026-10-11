import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";
import { describeAdmin } from "../Saga";
import { I18nProvider, makeI18n } from "../../i18n";
import { Glide } from "../../lib/live";
import { createLogStore } from "../../lib/useValheim";
import { emptyAgentState, type AdminStatus, type ApiState } from "../../types";

function fixture(): ApiState {
  const s = emptyAgentState(new Date("2026-10-09T20:00:00Z"));
  s.server = { ...s.server, name: "My Valheim", world: "Midgard", status: "running", version: "l-1.0.17" };
  s.players = [
    { name: "Ragnar", since: "2026-10-09T19:30:00Z", platform: "xbox" },
    { name: "Freya", since: "2026-10-09T19:40:00Z", platform: "steam" },
  ];
  return { ...s, online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } };
}

function status(over: Partial<AdminStatus> = {}, bridge: Partial<AdminStatus["bridge"]> = {}): AdminStatus {
  return {
    required: false,
    unlocked: true,
    idleMs: 1_800_000,
    ...over,
    bridge: { available: true, plugin: "0.1.1", gameBuild: "l-1.0.17", worldLoaded: true, timeFrozen: false, tested: true, acknowledged: false, testedBuilds: ["l-1.0.17"], commands: [], ...bridge },
  };
}

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };

/** The panel's API as far as these tests need it; everything else 404s. */
function api(st: AdminStatus, commands: (url: string, n: number) => Response = () => Response.json({ ok: true, data: {} })) {
  const calls: Call[] = [];
  let n = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
    if (u === "/api/admin/status") return Response.json(st);
    if (u === "/api/admin/catalog") return Response.json({ events: ["wolves"], currentEvent: null, globalKeys: ["defeated_eikthyr"], spots: ["spawn"] });
    if (u === "/api/admin/read/bans") return Response.json({ ok: true, data: [] });
    if (u === "/api/admin/unlock") return Response.json({ ok: true });
    if (u.startsWith("/api/admin/") && method === "POST") return commands(u, n++);
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const renderDashboard = () => render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);

async function openAdmin() {
  const button = await screen.findByRole("button", { name: "Admin" });
  fireEvent.click(button);
  return screen.findByRole("dialog", { name: "Admin" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("admin", () => {
  it("stays hidden when the agent has no bridge", async () => {
    const calls = api(status({}, { available: false, reason: "off" }));
    renderDashboard();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/admin/status")).toBe(true));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("broadcasts as the narrator, signed with this device's name", async () => {
    const store = new Map([["skald.admin.name", "Łukasz"]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    const calls = api(status());
    renderDashboard();
    const sheet = await openAdmin();
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Broadcast" }), { target: { value: "Boss at nine" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Narrator" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/broadcast")).toBeTruthy());
    const call = calls.find((c) => c.url === "/api/admin/broadcast")!;
    expect(call.body).toEqual({ text: "Boss at nine", type: "narrator" });
    expect(call.headers["X-Skald-Name"]).toBe(encodeURIComponent("Łukasz"));
    expect(await screen.findByText("Message sent.")).toBeInTheDocument();
  });

  it("gives items found by their Polish name to a player", async () => {
    const calls = api(status());
    renderDashboard();
    const sheet = await openAdmin();
    fireEvent.click(within(sheet).getAllByRole("button", { name: /Ragnar/ })[0]!);
    const player = await screen.findByRole("dialog", { name: "Ragnar" });
    fireEvent.click(within(player).getByRole("button", { name: "Give items" }));
    const picker = await screen.findByRole("dialog", { name: "Give items" });
    fireEvent.change(within(picker).getByRole("searchbox"), { target: { value: "drewno" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Wood" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Amount +" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Give" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/spawn")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/admin/spawn")!.body).toEqual({ item: "Wood", amount: 11, quality: 1, player: "Ragnar" });
  });

  it("asks for the admin password when the panel password is view-only, then retries", async () => {
    const calls = api(status({ required: true, unlocked: false }), (_url, n) =>
      n === 0 ? Response.json({ ok: false, error: "admin_required" }, { status: 403 }) : Response.json({ ok: true, data: { started: true } }),
    );
    renderDashboard();
    const sheet = await openAdmin();
    expect(within(sheet).getByText("View only")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Save the world now" }));
    const unlock = await screen.findByRole("dialog", { name: "Admin password" });
    fireEvent.change(within(unlock).getByLabelText("Admin password"), { target: { value: "jarl" } });
    fireEvent.click(within(unlock).getByRole("button", { name: "Unlock" }));
    fireEvent.click(await within(unlock).findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/admin/save")).toHaveLength(2));
    expect(calls.find((c) => c.url === "/api/admin/unlock")!.body).toEqual({ password: "jarl" });
  });

  it("says why controls are off and offers to allow an untested build", async () => {
    api(status({}, { tested: false, gameBuild: "l-1.0.18" }));
    renderDashboard();
    const sheet = await openAdmin();
    expect(within(sheet).getByText("Game build l-1.0.18 has not been tested with the bridge.")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /Allow build l-1.0.18/ })).toBeEnabled();
    expect(within(sheet).getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("needs the player's name typed before a ban can be held", async () => {
    api(status());
    renderDashboard();
    const sheet = await openAdmin();
    fireEvent.click(within(sheet).getAllByRole("button", { name: /Freya/ })[0]!);
    const player = await screen.findByRole("dialog", { name: "Freya" });
    const ban = within(player).getByRole("button", { name: /Ban Freya/ });
    expect(ban).toBeDisabled();
    fireEvent.change(within(player).getByLabelText("To ban, type Freya"), { target: { value: "Freya" } });
    expect(ban).toBeEnabled();
  });
});

describe("admin lines in the saga", () => {
  const en = makeI18n("en");
  const pl = makeI18n("pl");
  it("tells who did what for whom, never an id", () => {
    expect(describeAdmin(en, { actor: "Sigrun", command: "spawn", result: "ok", item: "Wood", amount: 20, player: "Ragnar" })).toBe("Sigrun spawned 20 Wood for Ragnar");
    expect(describeAdmin(en, { actor: "dashboard-1a2b3c", command: "spawn", result: "ok", items: [{ item: "Wood", amount: 20 }, { item: "SwordIron", amount: 1, quality: 3 }] })).toBe("An admin spawned 20 Wood, Iron Sword ★★★");
    expect(describeAdmin(en, { actor: "k", command: "kick", result: "ok", player: "Freya" })).toBe("k kicked Freya");
    expect(describeAdmin(en, { actor: "k", command: "time", result: "ok", dayFraction: 0.25 })).toBe("k set the time to 06:00");
    expect(describeAdmin(en, { actor: "k", command: "ban", result: "error", error: "no connected player 'X'" })).toBe("k: a ban failed (no connected player 'X')");
    expect(describeAdmin(pl, { actor: "Sigrun", command: "spawn", result: "ok", item: "Wood", amount: 20, player: "Ragnar" })).toBe("Sigrun przywołał 20 Drewno dla: Ragnar");
    expect(describeAdmin(pl, { actor: "k", command: "event-start", result: "ok", name: "wolves" })).toMatch(/^k sprowadził najazd: /);
  });
});

describe("live markers", () => {
  it("glide between samples and jump across portals", () => {
    const g = new Glide();
    const p = (x: number, z = 0) => [{ name: "Ragnar", platform: "xbox" as const, x, z, health: 1, maxHealth: 1 }];
    g.step(p(0), 0.016, false);
    expect(g.at("Ragnar")).toMatchObject({ x: 0, z: 0 });
    let moving = g.step(p(10), 0.1, false);
    expect(moving).toBe(true);
    const x = g.at("Ragnar")!.x;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(10);
    for (let i = 0; i < 200; i++) moving = g.step(p(10), 0.05, false);
    expect(moving).toBe(false);
    expect(g.at("Ragnar")!.x).toBeCloseTo(10, 1);
    g.step(p(2000), 0.016, false);
    expect(g.at("Ragnar")!.x).toBe(2000);
    g.step([], 0.016, false);
    expect(g.at("Ragnar")).toBeNull();
  });
});

describe("in Polish", () => {
  it("names the admin sheet", async () => {
    api(status());
    render(
      <I18nProvider locale="pl">
        <Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />
      </I18nProvider>,
    );
    const sheet = await openAdmin();
    expect(within(sheet).getByText("Komunikat")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Przewiń do rana" })).toBeInTheDocument();
  });
});
