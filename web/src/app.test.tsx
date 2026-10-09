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
import { emptyAgentState, type ApiState, type PlayerProfile } from "./types";

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
  it("renders every plank in English by default", () => {
    render(<Dashboard live={{ state: fixture(), logs: [], online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByRole("button", { name: /Join code 4 8 2 9 1 5/ })).toBeInTheDocument();
    for (const t of ["At the fire", "World", "Progress", "Saga", "Warrior ranking", "Forge", "Treasury", "Runes of power", "Chronicle"]) {
      expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    }
    expect(screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "Ragnar falls in battle")).toBeInTheDocument();
    expect(screen.getByText("Raid: Eikthyr's herd")).toBeInTheDocument();
    expect(screen.getByText("Day 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download backup worlds-20261009-180000.zip" })).toBeInTheDocument();
    expect(screen.getAllByText(/Prometheus is silent/).length).toBe(3);
    expect(screen.getByText("1 person")).toBeInTheDocument();
    expect(screen.getByText("1 backup")).toBeInTheDocument();
    expect(document.title).toBe("My Valheim - Skald");
  });

  it("explains how to enable the resource charts when Prometheus is not configured", () => {
    const s = fixture();
    s.metricsConfigured = false;
    render(<Dashboard live={{ state: s, logs: [], online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByText("The charts are asleep")).toBeInTheDocument();
    expect(screen.getByText(/Set PROM_URL/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How to enable metrics" })).toHaveAttribute("href", expect.stringContaining("#metrics"));
    expect(screen.queryByText(/Prometheus is silent/)).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "CPU usage, last 6 hours" })).not.toBeInTheDocument();
  });

  it("renders every plank from a state snapshot in Polish", () => {
    inPolish(<Dashboard live={{ state: fixture(), logs: [{ ts: "2026-10-09T19:59:00Z", line: "10/09/2026 19:59:00: World saved ( 87ms )" }], online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByRole("button", { name: /Kod dołączenia 4 8 2 9 1 5/ })).toBeInTheDocument();
    for (const t of ["Przy ognisku", "Świat", "Postęp", "Saga", "Ranking wojów", "Kuźnia", "Skarbiec", "Runy mocy", "Kronika"]) {
      expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    }
    expect(screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "Ragnar pada w boju")).toBeInTheDocument();
    const dl = screen.getByRole("link", { name: "Pobierz kopię worlds-20261009-180000.zip" });
    expect(dl).toHaveAttribute("href", "/api/backups/worlds-20261009-180000.zip");
    expect(dl).toHaveAttribute("download", "worlds-20261009-180000.zip");
    expect(screen.getByText("Najazd: stado Eikthyra")).toBeInTheDocument();
    expect(screen.getByText("Dzień 1")).toBeInTheDocument();
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
    inPolish(<Dashboard live={{ state: s, logs: [], online: true, lastAction: null }} onLogout={() => {}} />);
    expect(screen.getByText(/Zapis świata jeszcze nieczytelny/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Mapa świata/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Obiekty w świecie")).not.toBeInTheDocument();
    expect(screen.getAllByText("nieznane")).toHaveLength(7);
  });

  it("shows the outage banner and sleeps the runes when offline", () => {
    render(<Dashboard live={{ state: fixture(), logs: [], online: false, lastAction: null }} onLogout={() => {}} />);
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
    inPolish(<Dashboard live={{ state: fixture(), logs: [], online: true, lastAction: null }} onLogout={() => {}} />);
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
    expect(within(dialog).getByRole("img", { name: /Czas gry dziennie w ostatnich 30 dniach/ })).toBeInTheDocument();
    expect(within(dialog).getByText("Pierwsza krew").closest("li")).not.toHaveClass("opacity-45");
    expect(within(dialog).getByText("Nocny marek").closest("li")).toHaveClass("opacity-45");
    expect(within(dialog).getByText("jeszcze zamknięta")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/players/Ragnar", expect.anything());
    // Shift+Tab from the first focusable wraps inside the dialog.
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
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
    const view = render(<Dashboard live={{ state: fixture(), logs: [], online: true, lastAction: null }} onLogout={() => {}} />);
    const toggle = screen.getByRole("button", { name: "Campfire crackle" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(made).toEqual([]);
    act(() => toggle.click());
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(made).toEqual(["ctx"]);
    expect(store.get("skald_campfire_sound")).toBe("1");
    view.unmount();
    const again = render(<Dashboard live={{ state: fixture(), logs: [], online: true, lastAction: null }} onLogout={() => {}} />);
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
    expect(i.raidLabel("foresttrolls")).toBe("leśne trolle");
    expect(i.raidLabel("hildirboss2")).toBe("łowcy nagród Hildir");
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
    expect(i.raidLabel("army_eikthyr")).toBe("Eikthyr's herd");
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
    s = applyEvent(s, { seq: 10, ts: "2026-10-09T20:01:00Z", type: "player_join", data: { name: "Freya" } });
    expect(s.server.joinCode).toBe("123456");
    expect(s.players.map((p) => p.name)).toEqual(["Ragnar", "Freya"]);
    s = applyEvent(s, { seq: 11, ts: "2026-10-09T20:02:00Z", type: "player_count", data: { count: 0 } });
    expect(s.players).toEqual([]);
    expect(s.history.events).toHaveLength(2);
    s = applyEvent(s, { seq: 12, ts: "2026-10-09T20:03:00Z", type: "net_stats", data: { connections: 1, zdos: 9, sent: 0, recv: 0 } });
    expect(s.server.netStats).toEqual({ connections: 1, zdos: 9, sent: 0, recv: 0 });
  });
});
