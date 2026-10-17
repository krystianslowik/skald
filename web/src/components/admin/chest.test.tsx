import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_PLUGIN_VERSION } from "@server/bridgeplugin";
import { I18nProvider, makeI18n, type Locale } from "../../i18n";
import { clearPending, pendingItems } from "../../lib/chestadd";
import type { Marker } from "../../lib/mapgeo";
import { emptyAgentState, type AdminStatus, type ApiState, type MapContainer } from "../../types";
import { DetailsBody } from "../map/MapDetails";
import { describeAdmin } from "../Saga";
import { AdminProvider } from "./AdminContext";
import { ChestSheet } from "./ChestSheet";

// Fictional names only.
function state(): ApiState {
  const s = emptyAgentState(new Date("2026-10-09T20:00:00Z"));
  s.server = { ...s.server, world: "Midgard", status: "running", version: "l-1.0.17" };
  s.players = [{ name: "Ragnar", since: "2026-10-09T19:30:00Z", platform: "xbox" }];
  return { ...s, online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } };
}

function status(bridge: Partial<AdminStatus["bridge"]> = {}): AdminStatus {
  return {
    required: false,
    unlocked: true,
    idleMs: 1_800_000,
    notifyConfigured: false,
    bridge: { available: true, plugin: BRIDGE_PLUGIN_VERSION, gameBuild: "l-1.0.17", worldLoaded: true, timeFrozen: false, tested: true, acknowledged: false, testedBuilds: ["l-1.0.17"], commands: ["chest-add", "spawn"], ...bridge },
  };
}

const CHEST: MapContainer = {
  id: "piece_chest_wood@10,-4",
  kind: "chest",
  prefab: "piece_chest_wood",
  x: 10,
  y: 31.25,
  z: -4,
  width: 5,
  height: 2,
  items: [
    { name: "Wood", stack: 30, x: 0, y: 0 },
    { name: "Stone", stack: 50, x: 1, y: 0 },
  ],
};

const marker: Marker = { id: `store:${CHEST.id}`, layer: "storage", icon: "chest", x: CHEST.x, z: CHEST.z, priority: 35, tier: 1, rank: 60, label: "", labelScale: Infinity, data: { type: "storage", store: CHEST } };

type Call = { url: string; body: unknown };

function api(st: AdminStatus, answer: () => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u === "/api/admin/status") return Response.json(st);
      if (u === "/api/admin/chest-add") return answer();
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

const wrap = (ui: React.ReactNode, locale: Locale = "en") =>
  render(
    <I18nProvider locale={locale}>
      <AdminProvider state={state()} online onUnauthorized={() => {}} onShowMap={() => {}}>
        {ui}
      </AdminProvider>
    </I18nProvider>,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  clearPending();
});

describe("add item to a chest", () => {
  it("sends the chest, item and amount, then keeps the new slots as pending", async () => {
    const calls = api(status(), () => Response.json({ ok: true, data: { item: "Iron", amount: 10, loaded: true, room: 390, slots: [{ x: 2, y: 0, added: 10, stack: 10 }] } }));
    const onClose = vi.fn();
    wrap(<ChestSheet chest={CHEST} onClose={onClose} />);
    const sheet = screen.getByRole("dialog", { name: "Add item" });
    expect(within(sheet).getByText("Chest at 10, -4")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Add to chest" })).toBeDisabled();
    fireEvent.change(within(sheet).getByRole("searchbox"), { target: { value: "iron" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Iron" }));
    expect(within(sheet).getByRole("button", { name: "Iron" })).toHaveAttribute("aria-pressed", "true");
    expect(within(sheet).getByText("About 400 fit")).toBeInTheDocument();
    const go = within(sheet).getByRole("button", { name: "Add 10× Iron" });
    // Enabled once the bridge status is in.
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.url === "/api/admin/chest-add")!.body).toEqual({ prefab: "piece_chest_wood", at: { x: 10, y: 31.25, z: -4 }, item: "Iron", amount: 10 });
    expect(pendingItems(CHEST)).toContainEqual({ name: "Iron", stack: 10, x: 2, y: 0 });
    expect(await screen.findByText("10× Iron added to the Chest. Players nearby see it now.")).toBeInTheDocument();
  });

  it("shows why the bridge refused and keeps the sheet open", async () => {
    api(status(), () => Response.json({ ok: false, error: "a player has that chest open; try again once it is closed" }, { status: 409 }));
    const onClose = vi.fn();
    wrap(<ChestSheet chest={CHEST} onClose={onClose} />);
    const sheet = screen.getByRole("dialog", { name: "Add item" });
    fireEvent.change(within(sheet).getByRole("searchbox"), { target: { value: "wood" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Wood" }));
    const go = within(sheet).getByRole("button", { name: "Add 10× Wood" });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Someone has this chest open. Try again once they close it.");
    expect(onClose).not.toHaveBeenCalled();
    expect(pendingItems(CHEST)).toBeNull();
  });

  it("names the player standing at the chest, in Polish too", async () => {
    api(status(), () => Response.json({ ok: false, error: "Ragnar is standing at that chest; try again once they step away" }, { status: 409 }));
    wrap(<ChestSheet chest={CHEST} onClose={() => {}} />, "pl");
    const sheet = screen.getByRole("dialog", { name: "Do skrzyni" });
    fireEvent.change(within(sheet).getByRole("searchbox"), { target: { value: "drewno" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Drewno" }));
    const go = within(sheet).getByRole("button", { name: "Dodaj 10× Drewno" });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Ragnar stoi przy skrzyni. Spróbuj, gdy odejdzie.");
  });

  it("passes an unknown refusal through as the bridge wrote it", async () => {
    api(status(), () => Response.json({ ok: false, error: "the chest is haunted" }, { status: 409 }));
    wrap(<ChestSheet chest={CHEST} onClose={() => {}} />);
    const sheet = screen.getByRole("dialog", { name: "Add item" });
    fireEvent.change(within(sheet).getByRole("searchbox"), { target: { value: "wood" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Wood" }));
    const go = within(sheet).getByRole("button", { name: "Add 10× Wood" });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("the chest is haunted");
  });

  it("guesses the room, and leaves the exact count to the bridge", async () => {
    const calls = api(status(), () => Response.json({ ok: false, error: "that chest has no room for Stone" }, { status: 409 }));
    const full: MapContainer = { ...CHEST, width: 2, height: 1, items: [{ name: "Wood", stack: 45, x: 0, y: 0 }, { name: "Stone", stack: 50, x: 1, y: 0 }] };
    wrap(<ChestSheet chest={full} onClose={() => {}} />);
    const sheet = screen.getByRole("dialog", { name: "Add item" });
    const search = within(sheet).getByRole("searchbox");
    fireEvent.change(search, { target: { value: "wood" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Wood" }));
    expect(within(sheet).getByText("About 5 fit")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "stone" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Stone" }));
    expect(within(sheet).getByText("Looks full for this item")).toBeInTheDocument();
    // The web's stack sizes are a guess: the bridge has the last word.
    const go = within(sheet).getByRole("button", { name: "Add 1× Stone" });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("This chest has no room left for Stone.");
    expect(calls.filter((c) => c.url === "/api/admin/chest-add")).toHaveLength(1);
  });

  it("warns that a timed-out add may have gone in", async () => {
    api(status(), () => Response.json({ ok: false, error: "the bridge did not answer in time" }, { status: 504 }));
    wrap(<ChestSheet chest={CHEST} onClose={() => {}} />);
    const sheet = screen.getByRole("dialog", { name: "Add item" });
    fireEvent.change(within(sheet).getByRole("searchbox"), { target: { value: "wood" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Wood" }));
    const go = within(sheet).getByRole("button", { name: "Add 10× Wood" });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("The items may already be in the chest");
    expect(within(sheet).getByRole("button", { name: "Add 10× Wood again" })).toBeInTheDocument();
  });

  it("says nothing went in when the game never took the command (EN and PL)", async () => {
    const calls = api(status(), () => Response.json({ ok: false, error: "game main thread did not pick up the command in time" }, { status: 504 }));
    for (const [locale, search, item, add, said] of [
      ["en", "wood", "Wood", "Add 10× Wood", "The game was busy and did not take the command, so nothing was done."],
      ["pl", "drewno", "Drewno", "Dodaj 10× Drewno", "Gra była zajęta i nie przyjęła polecenia, więc nic się nie stało."],
    ] as const) {
      const view = wrap(<ChestSheet chest={CHEST} onClose={() => {}} />, locale);
      const sheet = screen.getByRole("dialog");
      fireEvent.change(within(sheet).getByRole("searchbox"), { target: { value: search } });
      fireEvent.click(within(sheet).getByRole("button", { name: item }));
      const go = within(sheet).getByRole("button", { name: add });
      await waitFor(() => expect(go).toBeEnabled());
      fireEvent.click(go);
      const alert = await within(sheet).findByRole("alert");
      expect(alert).toHaveTextContent(said);
      expect(alert).not.toHaveTextContent(/may already be in the chest|mogą już być w skrzyni/);
      // Nothing went in, so the button is the plain add, not "again".
      expect(within(sheet).getByRole("button", { name: add })).toBeInTheDocument();
      view.unmount();
    }
    expect(calls.filter((c) => c.url === "/api/admin/chest-add")).toHaveLength(2);
  });

  it("speaks Polish", () => {
    api(status(), () => Response.json({ ok: true, data: {} }));
    wrap(<ChestSheet chest={CHEST} onClose={() => {}} />, "pl");
    const sheet = screen.getByRole("dialog", { name: "Do skrzyni" });
    fireEvent.change(within(sheet).getByRole("searchbox"), { target: { value: "drewno" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Drewno" }));
    expect(within(sheet).getByRole("button", { name: "Dodaj 10× Drewno" })).toBeInTheDocument();
    expect(within(sheet).getByText("Zmieści się około 420")).toBeInTheDocument();
  });
});

describe("the chest on the map", () => {
  it("offers Add item to an admin and shows pending items", async () => {
    api(status(), () => Response.json({ ok: true, data: {} }));
    wrap(<DetailsBody marker={marker} seedName="" roomy />);
    const add = await screen.findByRole("button", { name: "Add item" });
    expect(add).toBeEnabled();
    expect(screen.queryByText(/Includes items added just now/)).not.toBeInTheDocument();
  });

  it("hides Add item when the agent does not know the command, and disables it on an old bridge", async () => {
    api(status({ commands: ["spawn"] }), () => Response.json({ ok: true, data: {} }));
    const { unmount } = wrap(<DetailsBody marker={marker} seedName="" roomy />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Add item" })).not.toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();
    api(status({ plugin: "0.3.0" }), () => Response.json({ ok: true, data: {} }));
    wrap(<DetailsBody marker={marker} seedName="" roomy />);
    expect(await screen.findByRole("button", { name: "Add item" })).toBeDisabled();
  });
});

describe("the saga line", () => {
  it("says what went into which chest, never an id", () => {
    const ev = { actor: "Sigrun", command: "chest-add", result: "ok", item: "Iron", amount: 20, prefab: "piece_chest_wood", at: { x: 208, z: -352 }, loaded: true };
    expect(describeAdmin(makeI18n("en"), ev)).toBe("Sigrun added 20 Iron to a chest at 208, -352");
    expect(describeAdmin(makeI18n("pl"), ev)).toBe("Sigrun dodał 20 Żelazo do skrzyni na 208, -352");
    expect(describeAdmin(makeI18n("en"), { actor: "k", command: "chest-add", result: "error", error: "only 13 Wood fit in that chest" })).toBe("k: adding to a chest failed (Only 13 fit in this chest: Wood)");
  });
});
