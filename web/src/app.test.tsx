import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { Dashboard } from "./components/Dashboard";
import { en } from "./i18n/en";
import { I18nProvider, makeI18n } from "./i18n";
import { pl } from "./i18n/pl";
import { applyEvent } from "./lib/apply";
import { stripValheimStamp } from "./lib/format";
import { createLogStore } from "./lib/useValheim";
import { COARSE, PHONE } from "./lib/useMedia";
import { emptyAgentState, type ApiState, type PlayerProfile, type SettingsView } from "./types";

const inPolish = (ui: ReactElement) => render(<I18nProvider locale="pl">{ui}</I18nProvider>);

/** A plain in-memory localStorage: Node's own experimental global shadows jsdom's here. */
function memoryStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  return store;
}

function fixture(): ApiState {
  const s = emptyAgentState(new Date("2026-10-09T20:00:00Z"));
  s.server = { ...s.server, name: "My Valheim", world: "Midgard", status: "running", joinCode: "482915", version: "l-1.0.17", serverStartedAt: "2026-10-09T18:00:00Z" };
  s.players = [{ name: "Ragnar", since: "2026-10-09T19:30:00Z" }];
  s.server.netStats = { connections: 2, zdos: 131042, sent: 10, recv: 200 };
  s.world.meta = { name: "Midgard", seedName: "ZbzIWkK5KK", seed: 353373721, worldGenVersion: 2, netTime: 2040, day: 1, savedAt: "2026-10-09T19:55:00Z" };
  s.backups = [{ name: "worlds-20261009-180000.zip", sizeBytes: 41_000_000, modifiedAt: "2026-10-09T18:00:00Z" }];
  return {
    ...s,
    online: true,
    metricsConfigured: true,
    metrics: null,
    history: {
      players: [{ name: "Ragnar", sessions: 3, playtimeMs: 7_200_000, deaths: 2, lastSeen: "2026-10-09T19:30:00Z", online: true }],
      events: [
        { seq: 5, ts: "2026-10-09T19:45:00Z", type: "raid", data: { name: "army_eikthyr" } },
        { seq: 4, ts: "2026-10-09T19:40:00Z", type: "death", data: { name: "Ragnar" } },
      ],
      online7d: [
        [Date.parse("2026-10-02T20:00:00Z"), 0],
        [Date.parse("2026-10-09T19:30:00Z"), 1],
        [Date.parse("2026-10-09T20:00:00Z"), 1],
      ],
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Dashboard", () => {
  it("opens the world map at #map and Back closes it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    history.replaceState(null, "", "/");
    render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Open the world map" }));
    expect(location.hash).toBe("#map");
    expect(history.state).toEqual({ skaldMap: true });
    expect(await screen.findByRole("dialog", { name: "World map" })).toBeInTheDocument();
    act(() => {
      history.back();
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "World map" })).not.toBeInTheDocument());
    // Landing on #map directly: closing drops the hash without leaving the page.
    history.replaceState(null, "", "/#map");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    fireEvent.click(await screen.findByRole("button", { name: "Close map" }));
    expect(location.hash).toBe("");
  });

  it("renders every plank in English by default", () => {
    render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByRole("button", { name: /Join code 4 8 2 9 1 5/ })).toBeInTheDocument();
    for (const t of ["At the fire", "World", "Progress", "Saga", "Warrior ranking", "Forge", "Treasury", "Runes of power", "Chronicle"]) {
      expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    }
    expect(screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "Ragnar falls in battle")).toBeInTheDocument();
    expect(screen.getByText("Raid: Eikthyr rallies the creatures of the forest")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "World" })).getByText("Day 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download backup worlds-20261009-180000.zip" })).toBeInTheDocument();
    expect(screen.getAllByText(/Prometheus is silent/).length).toBe(3);
    expect(screen.getByText("1 person")).toBeInTheDocument();
    expect(screen.getByText("1 backup")).toBeInTheDocument();
    expect(document.title).toBe("My Valheim - Skald");
  });

  it("explains how to enable the resource charts when Prometheus is not configured", () => {
    const s = fixture();
    s.metricsConfigured = false;
    render(<Dashboard live={{ state: s, logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByText("The charts are asleep")).toBeInTheDocument();
    expect(screen.getByText(/Set PROM_URL/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How to enable metrics" })).toHaveAttribute("href", expect.stringContaining("#metrics"));
    expect(screen.queryByText(/Prometheus is silent/)).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "CPU usage, last 6 hours" })).not.toBeInTheDocument();
  });

  it("renders every plank from a state snapshot in Polish", () => {
    inPolish(<Dashboard live={{ state: fixture(), logs: createLogStore([{ ts: "2026-10-09T19:59:00Z", line: "10/09/2026 19:59:00: World saved ( 87ms )" }]), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByRole("button", { name: /Kod dołączenia 4 8 2 9 1 5/ })).toBeInTheDocument();
    for (const t of ["Przy ognisku", "Świat", "Postęp", "Saga", "Ranking wojów", "Kuźnia", "Skarbiec", "Runy mocy", "Kronika"]) {
      expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    }
    expect(screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "Ragnar pada w boju")).toBeInTheDocument();
    const dl = screen.getByRole("link", { name: "Pobierz kopię worlds-20261009-180000.zip" });
    expect(dl).toHaveAttribute("href", "/api/backups/worlds-20261009-180000.zip");
    expect(dl).toHaveAttribute("download", "worlds-20261009-180000.zip");
    expect(screen.getByText("Najazd: Eikthyr gromadzi leśne stworzenia")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Świat" })).getByText("Dzień 1")).toBeInTheDocument();
    const map = screen.getByRole("link", { name: /Mapa świata/ });
    expect(map).toHaveAttribute("href", "https://valheim-map.world/?seed=ZbzIWkK5KK&offset=0,0&zoom=0.600&ver=1.0.7");
    expect(map).toHaveAttribute("target", "_blank");
    expect(map.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("button", { name: "Skopiuj ziarno ZbzIWkK5KK" })).toBeInTheDocument();
    expect(screen.getByText("Obiekty w świecie")).toBeInTheDocument();
    expect(screen.getAllByText("nieznane")).toHaveLength(7);
    expect(screen.getByText("World saved ( 87ms )")).toBeInTheDocument();
    expect(screen.getAllByText(/Prometheus milczy/).length).toBe(3);
    expect(screen.queryByText(/Ogień przygasł/)).not.toBeInTheDocument();
  });

  it("renders the world and progress placeholders before the save is readable", () => {
    const s = fixture();
    s.world.meta = null;
    s.server.netStats = null;
    inPolish(<Dashboard live={{ state: s, logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByText(/Zapis świata nie jest jeszcze czytelny/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Mapa świata/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Obiekty w świecie")).not.toBeInTheDocument();
    expect(screen.getAllByText("nieznane")).toHaveLength(7);
  });

  it("lights the boss path, shows the world's modifiers and each player's platform", () => {
    const s = fixture();
    s.server.args = "-crossplay";
    s.players = [
      { name: "Ragnar", since: "2026-10-09T19:30:00Z", platform: "xbox" },
      { name: "Freya", since: "2026-10-09T19:40:00Z", platform: "steam" },
      { name: "Bjorn", since: "2026-10-09T19:50:00Z", platform: "unknown" },
    ];
    s.world.meta = {
      ...s.world.meta!,
      modifiers: { portals: "casual", resources: "muchmore" },
      worldKeys: ["resourcerate 200", "teleportall"],
      bosses: ["eikthyr", "gdking", "bonemass", "dragon", "goblinking", "queen", "fader"].map((b, i) => ({ key: `defeated_${b}`, defeated: i < 2 })),
    };
    render(<Dashboard live={{ state: s, logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    // Two trophies, plus the readout under the strip naming the last one down.
    expect(screen.getAllByText("defeated")).toHaveLength(3);
    expect(screen.getByText("The Elder", { selector: ".boss-title" })).toBeInTheDocument();
    expect(screen.getAllByText("waiting")).toHaveLength(5);
    expect(screen.queryByText(/Lights up once/)).not.toBeInTheDocument();
    for (const m of ["crossplay", "portals: casual", "resources: much more", "teleport everything"]) expect(screen.getByText(m)).toBeInTheDocument();
    expect(screen.queryByText(/resourcerate/)).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Xbox" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "PC (Steam)" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Unknown platform" })).not.toBeInTheDocument();
  });

  it("keeps the header stacked on a tablet and lays it out in a row only from the lg breakpoint", () => {
    render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    const header = screen.getByRole("heading", { level: 1, name: "My Valheim" }).closest("header")!;
    const facts = header.querySelector("dl")!;
    // At 640-1023 px the row squeezed the title to a few pixels (#57).
    for (const el of [header, ...header.querySelectorAll("*")]) {
      expect([...el.classList].filter((c) => /^(sm|md):(flex-row|flex-1|flex-nowrap|border-0)$/.test(c))).toEqual([]);
    }
    expect(header).toHaveClass("flex-col", "lg:flex-row");
    expect(facts).toHaveClass("flex-wrap", "lg:flex-nowrap");
  });

  it("shows the outage banner and sleeps the runes when offline", () => {
    render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: false, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByText("The fire has dimmed.")).toBeInTheDocument();
    const runes = screen.getAllByRole("button", { name: /Hold for one and a half seconds/ });
    expect(runes).toHaveLength(3);
    for (const b of runes) expect(b).toBeDisabled();
  });
});

function profile(): PlayerProfile {
  return {
    name: "Ragnar",
    online: false,
    platform: "xbox",
    firstSeen: "2026-09-12T18:00:00Z",
    lastSeen: "2026-10-09T19:30:00Z",
    playtimeMs: 12 * 3_600_000,
    sessions: 9,
    longestSessionMs: 5.5 * 3_600_000,
    deaths: 3,
    deathsPerHour: 0.25,
    currentStreak: 4,
    longestStreak: 9,
    daily: Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.UTC(2026, 8, 10 + i)).toISOString().slice(0, 10), ms: i % 3 === 0 ? 3_600_000 : 0 })),
    badges: [
      { id: "first_blood", earnedAt: "2026-09-20T20:00:00Z" },
      { id: "night_owl", earnedAt: null },
    ],
  };
}

describe("Profile sheet", () => {
  it("opens from a player name, shows stats and badges, traps focus and closes on Escape", async () => {
    const fetchMock = vi.fn(async (url: string) => (String(url) === "/api/players/Ragnar" ? Response.json(profile()) : new Response("{}", { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);
    inPolish(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    const ranking = screen.getByRole("heading", { name: "Ranking wojów" }).closest("section")!;
    const opener = within(ranking).getByRole("button", { name: "Ragnar" });
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Ragnar" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const close = within(dialog).getByRole("button", { name: "Zamknij profil" });
    expect(close).toHaveFocus();
    await within(dialog).findByText("12 h");
    expect(within(dialog).getByText("najdłuższa 9 dni")).toBeInTheDocument();
    expect(within(dialog).getByText("0,25 na godzinę")).toBeInTheDocument();
    expect(within(dialog).getByRole("img", { name: /Czas gry w ostatnich 30 dniach/ })).toBeInTheDocument();
    expect(within(dialog).getByText("Pierwsza krew").closest("li")).not.toHaveClass("opacity-45");
    expect(within(dialog).getByText("Nocny marek").closest("li")).toHaveClass("opacity-45");
    expect(within(dialog).getByText("jeszcze niezdobyta")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/players/Ragnar", expect.anything());
    // Shift+Tab from the first focusable wraps inside the dialog.
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    // The sheet leaves along its own edge before it unmounts.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 3000 });
    expect(opener).toHaveFocus();
  });
});

function settingsView(): SettingsView {
  return {
    current: { name: "My Valheim", public: true, preset: "normal", modifiers: { raids: "less" }, keys: [], saveInterval: 1800, unmanaged: ["-crossplay"] },
    pending: false,
    effective: { name: "My Valheim", public: true, args: "-modifier raids less -crossplay" },
    password: { set: true },
    apply: { armed: false, since: null },
    hook: "ok",
    updatedAt: null,
  };
}

function withSettings(pending = false, armed = false): ApiState {
  return { ...fixture(), settings: { enabled: true, pending, armed, passwordSet: true } };
}

describe("Server settings", () => {
  it("is hidden while the agent has the feature off", () => {
    render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.queryByRole("button", { name: "Server settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show password" })).not.toBeInTheDocument();
  });

  it("shows the server password next to the join code only when asked", async () => {
    const fetchMock = vi.fn(async (url: string) => (String(url) === "/api/settings/password" ? Response.json({ password: "hearth-77" }) : new Response("{}", { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard live={{ state: withSettings(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.queryByText("hearth-77")).not.toBeInTheDocument();
    // The map board fetches the map; the password is never fetched unasked.
    expect(fetchMock).not.toHaveBeenCalledWith("/api/settings/password", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(await screen.findByText("hearth-77")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/password", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(screen.queryByText("hearth-77")).not.toBeInTheDocument();
  });

  it("shows the pending chip and the armed chip with its cancel", () => {
    const fetchMock = vi.fn(async () => Response.json(settingsView()));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<Dashboard live={{ state: withSettings(true), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByRole("button", { name: /Saved settings wait for a restart/ })).toHaveTextContent("Restart pending");
    rerender(<Dashboard live={{ state: withSettings(true, true), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByRole("button", { name: /Saved settings wait for a restart/ })).toHaveTextContent("Applies when empty");
    fireEvent.click(screen.getByRole("button", { name: "Cancel applying when the server is empty" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/apply", expect.objectContaining({ method: "DELETE" }));
  });

  it("validates inline, counts changes, turns a preset custom and saves", async () => {
    const puts: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/settings" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        const v = settingsView();
        return Response.json({ ...v, pending: true, current: { ...v.current, ...body } });
      }
      if (String(url) === "/api/settings") return Response.json(settingsView());
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard live={{ state: withSettings(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Server settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await within(dialog).findByText("World modifiers");
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(within(dialog).getByText("No changes")).toBeInTheDocument();
    // Unmanaged launch options are shown, read-only.
    expect(within(dialog).getByText("-crossplay")).toBeInTheDocument();
    // The seeded raids modifier makes the world custom.
    expect(within(dialog).getByText("Your own mix of modifiers.")).toBeInTheDocument();

    // Inline validation, before any submit.
    const name = within(dialog).getByLabelText("Server name");
    fireEvent.change(name, { target: { value: "ab" } });
    expect(within(dialog).getByText("3 to 40 characters.")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(save).toBeDisabled();
    fireEvent.change(name, { target: { value: "Hall of Ash" } });
    expect(within(dialog).queryByText("3 to 40 characters.")).not.toBeInTheDocument();
    expect(within(dialog).getByText("1 change")).toBeInTheDocument();
    expect(save).toBeEnabled();

    // A preset clears the overrides; a single step makes it custom on top of it.
    const presets = within(dialog).getByRole("radiogroup", { name: "Presets" });
    fireEvent.click(within(presets).getByRole("radio", { name: "Hard" }));
    expect(within(presets).getByRole("radio", { name: "Hard" })).toHaveAttribute("aria-checked", "true");
    expect(await within(dialog).findByText("Harder combat and more frequent raids.")).toBeInTheDocument();
    const raids = within(dialog).getByRole("radiogroup", { name: "raids" });
    expect(within(raids).getByRole("radio", { name: "preset" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(raids).getByRole("radio", { name: "none" }));
    expect(await within(dialog).findByText("Your own mix, based on Hard.")).toBeInTheDocument();
    expect(within(presets).getByRole("radio", { name: "Hard" })).toHaveAttribute("aria-checked", "false");
    expect(within(dialog).getByText("No raids on your bases.")).toBeInTheDocument();
    expect(within(dialog).getByText("3 changes")).toBeInTheDocument();

    // A password that Valheim would refuse, shown as you type.
    const pw = within(dialog).getByLabelText("Server password");
    fireEvent.change(pw, { target: { value: "ash" } });
    expect(within(dialog).getByText("5 to 32 characters.")).toBeInTheDocument();
    fireEvent.change(pw, { target: { value: "" } });

    fireEvent.click(save);
    await within(dialog).findByText("Saved. A restart applies it.");
    expect(puts).toEqual([{ name: "Hall of Ash", public: true, preset: "hard", modifiers: { raids: "none" }, keys: [], saveInterval: 1800 }]);
    expect(within(dialog).getByRole("button", { name: /Apply now: restart the server/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Apply when the server is empty/ })).toBeInTheDocument();
  });

  it("preselects the world's own modifiers and says so", async () => {
    const puts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return Response.json({ ...settingsView(), pending: true });
      }
      return String(url) === "/api/settings" ? Response.json(settingsView()) : new Response("{}", { status: 404 });
    }));
    const s = withSettings();
    s.world.meta = { ...s.world.meta!, modifiers: { resources: "muchmore", portals: "casual", raids: "less" } };
    render(<Dashboard live={{ state: s, logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Server settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    // raids is already in the settings; only what they lack is named.
    expect(await within(dialog).findByText("This world was created with: resources much more, portals casual. They are selected below so a save keeps them.")).toBeInTheDocument();
    const resources = within(dialog).getByRole("radiogroup", { name: "resources" });
    expect(within(resources).getByRole("radio", { name: "much more" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByText("2 changes")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect((puts[0] as { modifiers: Record<string, string> }).modifiers).toEqual({ raids: "less", resources: "muchmore", portals: "casual" });
  });

  it("rolls back an optimistic save the agent refuses", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return Response.json({ ok: false, message: "invalid settings", errors: { name: "chars" } }, { status: 400 });
      return String(url) === "/api/settings" ? Response.json(settingsView()) : new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard live={{ state: withSettings(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Server settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.change(await within(dialog).findByLabelText("Server name"), { target: { value: "Hall of Ash" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await within(dialog).findByText("Fix the marked fields first.");
    expect(within(dialog).getByText("Only letters, digits, spaces and - _ . ' !")).toBeInTheDocument();
    expect(within(dialog).getByText("1 change")).toBeInTheDocument();
  });

  it("tells the saga about settings without ever naming the password", () => {
    const s = withSettings();
    s.history.events = [
      { seq: 8, ts: "2026-10-09T19:52:00Z", type: "settings_apply", data: { state: "applied", mode: "when_empty" } },
      { seq: 7, ts: "2026-10-09T19:51:00Z", type: "settings_changed", data: { changedKeys: ["name", "password", "modifier.raids", "key.nomap"] } },
    ];
    render(<Dashboard live={{ state: s, logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByText("Server settings changed: name, password, raids, no map")).toBeInTheDocument();
    expect(screen.getByText("New settings are in effect")).toBeInTheDocument();
  });
});

describe("Campfire sound", () => {
  it("is off by default, remembers the toggle, and only builds audio after the click", () => {
    const made: string[] = [];
    const param = () => ({ value: 0, setTargetAtTime() {} });
    const node = () => ({ connect: (n: unknown) => n, gain: param(), frequency: param(), Q: param(), playbackRate: param(), type: "", buffer: null, loop: false, start() {} });
    class FakeAudioContext {
      sampleRate = 8000;
      currentTime = 0;
      state = "suspended";
      destination = {};
      constructor() {
        made.push("ctx");
      }
      createGain = node;
      createBiquadFilter = node;
      createBufferSource = node;
      createBuffer = (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) });
      resume = async () => undefined;
      suspend = async () => undefined;
      close = async () => undefined;
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const store = memoryStorage();
    const view = render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    const toggle = screen.getByRole("button", { name: "Campfire crackle" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(made).toEqual([]);
    act(() => toggle.click());
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(made).toEqual(["ctx"]);
    expect(store.get("skald_campfire_sound")).toBe("1");
    view.unmount();
    const again = render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByRole("button", { name: "Campfire crackle" })).toHaveAttribute("aria-pressed", "true");
    again.unmount();
  });
});

describe("App", () => {
  const api = (locale: string) =>
    vi.fn(async (url: string) => (String(url) === "/api/config" ? Response.json({ locale }) : new Response("{}", { status: 401 })));

  it("shows the login campfire in the server's default language", async () => {
    memoryStorage();
    vi.stubGlobal("fetch", api("en"));
    render(<App />);
    await waitFor(() => expect(screen.getByPlaceholderText("Speak the word")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Kindle" })).toBeInTheDocument();
    expect(document.title).toBe("Skald");
    expect(document.documentElement.lang).toBe("en");
  });

  it("starts in Polish when SKALD_LOCALE=pl and the viewer has no choice stored", async () => {
    memoryStorage();
    vi.stubGlobal("fetch", api("pl"));
    render(<App />);
    await waitFor(() => expect(screen.getByPlaceholderText("Wypowiedz słowo")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Rozpal" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("pl");
  });

  it("lets the viewer switch language and remembers it over the server default", async () => {
    const store = memoryStorage();
    vi.stubGlobal("fetch", api("pl"));
    const view = render(<App />);
    await waitFor(() => expect(screen.getByPlaceholderText("Wypowiedz słowo")).toBeInTheDocument());
    act(() => screen.getByRole("button", { name: "Switch language to English" }).click());
    expect(screen.getByPlaceholderText("Speak the word")).toBeInTheDocument();
    expect(store.get("skald_locale")).toBe("en");
    view.unmount();
    render(<App />);
    await waitFor(() => expect(screen.getByPlaceholderText("Speak the word")).toBeInTheDocument());
  });

  it.each([
    ["a 502 from /api/me", () => new Response("bad gateway", { status: 502 })],
    ["no network", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("keeps a signed-in viewer on the panel on %s, and only a 401 signs them out", async (_, fail) => {
    memoryStorage();
    let signedIn = true;
    const sockets: { onclose: (() => void) | null }[] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        readyState = 0;
        onopen = null;
        onmessage = null;
        onclose: (() => void) | null = null;
        constructor() {
          sockets.push(this);
        }
        close() {}
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url) === "/api/config") return Response.json({ locale: "en" });
        if (String(url) === "/api/me") return fail();
        if (signedIn) return new Response("down", { status: 503 });
        return new Response("{}", { status: 401 });
      }),
    );
    render(<App />);
    expect(await screen.findByText("Stirring the embers...")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Speak the word")).not.toBeInTheDocument();
    // The session really expired: the server drops the socket, and the panel's check sees the 401.
    signedIn = false;
    act(() => sockets.at(-1)?.onclose?.());
    await waitFor(() => expect(screen.getByPlaceholderText("Speak the word")).toBeInTheDocument());
  });
});

describe("i18n", () => {
  it("keeps both dictionaries in step", () => {
    expect(Object.keys(pl).sort()).toEqual(Object.keys(en).sort());
  });

  it("formats Polish plurals, durations and labels", () => {
    const i = makeI18n("pl");
    expect(i.tn("plank.hearth.aside", 1)).toBe("1 osoba");
    expect(i.tn("plank.hearth.aside", 3)).toBe("3 osoby");
    expect(i.tn("plank.hearth.aside", 12)).toBe("12 osób");
    expect(i.tn("plank.hearth.aside", 22)).toBe("22 osoby");
    expect(i.tn("plank.treasury.aside", 5)).toBe("5 kopii");
    expect(i.duration(3 * 3_600_000 + 17 * 60_000)).toBe("3 h 17 min");
    expect(i.duration(2 * 86_400_000 + 3 * 3_600_000)).toBe("2 dni 3 h");
    expect(i.ago(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5 min temu");
    expect(i.ago(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe("3 dni temu");
    expect(i.modifiers("-crossplay -modifier raids less")).toEqual(["crossplay", "najazdy: rzadziej"]);
    expect(i.raidLabel("foresttrolls")).toBe("Ziemia drży");
    expect(i.raidLabel("hildirboss2")).toBe("Przechodzą cię ciarki");
    expect(i.raidLabel("army_new_thing")).toBe("army_new_thing");
    expect(i.number(0.25, 2)).toBe("0,25");
  });

  it("formats English plurals, durations and labels", () => {
    const i = makeI18n("en");
    expect(i.tn("plank.hearth.aside", 1)).toBe("1 person");
    expect(i.tn("plank.hearth.aside", 2)).toBe("2 people");
    expect(i.tn("plank.hearth.aside", 0)).toBe("0 people");
    expect(i.duration(86_400_000 + 3_600_000)).toBe("1 day 1 h");
    expect(i.duration(20_000)).toBe("less than a minute");
    expect(i.ago(new Date(Date.now() - 2 * 3_600_000).toISOString())).toBe("2 h ago");
    expect(i.ago(null)).toBe("never");
    expect(i.modifiers("-modifier deathpenalty casual -preset hard")).toEqual(["death penalty: casual", "preset: hard"]);
    expect(i.raidLabel("army_eikthyr")).toBe("Eikthyr rallies the creatures of the forest");
    expect(i.lookup("badge.night_owl.label")).toBe("Night owl");
    expect(i.lookup("badge.nope.label")).toBeUndefined();
    expect(i.number(0.25, 2)).toBe("0.25");
  });
});

describe("helpers", () => {
  it("strips Valheim's own timestamps and ANSI colours", () => {
    expect(stripValheimStamp("10/09/2026 22:28:39: Session x")).toBe("Session x");
    expect(stripValheimStamp("\x1b[0mWaiting for client config... [0m")).toBe("Waiting for client config... ");
  });

  it("applies live events to state", () => {
    let s = fixture();
    s = applyEvent(s, { seq: 9, ts: "2026-10-09T20:01:00Z", type: "join_code", data: { code: "123456" } });
    s = applyEvent(s, { seq: 10, ts: "2026-10-09T20:01:00Z", type: "player_join", data: { name: "Freya", platform: "steam" } });
    expect(s.server.joinCode).toBe("123456");
    expect(s.players.find((p) => p.name === "Freya")?.platform).toBe("steam");
    expect(s.players.map((p) => p.name)).toEqual(["Ragnar", "Freya"]);
    s = applyEvent(s, { seq: 11, ts: "2026-10-09T20:02:00Z", type: "player_count", data: { count: 0 } });
    expect(s.players).toEqual([]);
    expect(s.history.events).toHaveLength(2);
    s = applyEvent(s, { seq: 12, ts: "2026-10-09T20:03:00Z", type: "net_stats", data: { connections: 1, zdos: 9, sent: 0, recv: 0 } });
    expect(s.server.netStats).toEqual({ connections: 1, zdos: 9, sent: 0, recv: 0 });
  });
});

describe("On a phone", () => {
  const media = window as unknown as { __media?: Record<string, boolean> };
  afterEach(() => {
    media.__media = {};
    delete (navigator as { share?: unknown }).share;
  });
  function phone() {
    media.__media = { [PHONE]: true, [COARSE]: true };
    history.replaceState(null, "", "/");
  }
  const clip = () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  };

  it("shows one tab at a time and Back returns to the fire", async () => {
    phone();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    const tabs = screen.getByRole("navigation", { name: "Sections" });
    expect(within(tabs).getByRole("link", { name: "Fire" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText(/^Tap to copy\./)).toBeInTheDocument();
    // The header's buttons moved to the Settings tab.
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Saga" })).not.toBeInTheDocument();

    fireEvent.click(within(tabs).getByRole("link", { name: "Saga" }));
    expect(location.hash).toBe("#saga");
    expect(screen.getByRole("heading", { name: "Saga" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Warrior ranking" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Join code 4 8 2 9 1 5/ })).not.toBeInTheDocument();

    // Tab to tab replaces the entry, so one Back is home.
    fireEvent.click(within(tabs).getByRole("link", { name: "Settings" }));
    expect(location.hash).toBe("#settings");
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chronicle" })).toBeInTheDocument();
    act(() => {
      history.back();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Join code 4 8 2 9 1 5/ })).toBeInTheDocument());
    expect(location.hash).toBe("");

    // The Map tab keeps the bar and has no back button of its own.
    fireEvent.click(within(tabs).getByRole("link", { name: "Map" }));
    expect(await screen.findByRole("dialog", { name: "World map" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Sections" })).getByRole("link", { name: "Map" })).toHaveAttribute("aria-current", "page");
  });

  it("shares the code and the password through the share sheet", async () => {
    phone();
    const share = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url) === "/api/settings/password" ? Response.json({ password: "hearth-77" }) : new Response("{}", { status: 404 }))));
    render(<Dashboard live={{ state: withSettings(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByRole("checkbox", { name: "Include password" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Share the join code" }));
    await waitFor(() => expect(share).toHaveBeenCalledWith({ text: "Join My Valheim in Valheim: code 482915, password hearth-77" }));
    // Without the password, only the code goes.
    fireEvent.click(screen.getByRole("checkbox", { name: "Include password" }));
    fireEvent.click(screen.getByRole("button", { name: "Share the join code" }));
    await waitFor(() => expect(share).toHaveBeenLastCalledWith({ text: "Join My Valheim in Valheim: code 482915" }));
  });

  it("copies the invite where there is no share sheet, in Polish too", async () => {
    phone();
    const writeText = clip();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    inPolish(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByText(/^Stuknij, aby skopiować\./)).toBeInTheDocument();
    // No password on this server: no toggle either.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Udostępnij kod dołączenia" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Dołącz do My Valheim w Valheim: kod 482915"));
    expect(await screen.findByText("Zaproszenie skopiowane")).toBeInTheDocument();
  });
});
