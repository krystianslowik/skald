import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockCompat } from "@server/mockcompat";
import { BRIDGE_PLUGIN_VERSION } from "@server/bridgeplugin";
import { I18nProvider, makeI18n } from "../i18n";
import { createLogStore } from "../lib/useValheim";
import { preloadLazyChunks } from "../test-preload";
import { emptyAgentState, type AdminStatus, type ApiState, type CompatView } from "../types";
import { CompatNotice, CompatRows, containerWhy } from "./Compat";
import { Dashboard } from "./Dashboard";

const NOW = Date.parse("2026-10-18T20:00:00Z");
const view = (mode: string): CompatView => mockCompat(mode, "l-1.0.20", 41, NOW);
const inLocale = (ui: ReactElement, locale: "en" | "pl" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);

function memoryStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  return store;
}

beforeAll(preloadLazyChunks);
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("compatibility rows", () => {
  it("lists every part with what it found", () => {
    inLocale(<CompatRows view={view("fail")} />);
    expect(screen.getByText("Game updated from 1.0.16 to 1.0.20.")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Game compatibility" })).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("p")!.textContent)).toEqual(["Version", "World save", "Terrain", "Admin plugin", "Server log"]);
    expect(rows[1]).toHaveTextContent("41 containers cannot be read: the game saves inventories in a new format (version 111) that Skald does not know yet.");
    expect(within(rows[1]!).getByRole("img", { name: "broken" })).toBeInTheDocument();
    expect(within(rows[3]!).getByRole("img", { name: "needs a look" })).toBeInTheDocument();
    expect(rows[3]).toHaveTextContent("Plugin 0.2.0 is not tested on 1.0.20");
    expect(within(rows[2]!).getByRole("img", { name: "waiting" })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("1.0.20, was 1.0.16. Players need to update their game too (network version 40 to 41).");
    expect(rows[4]).toHaveTextContent("the world loaded after 25 s and a join code was issued");
  });

  it("speaks Polish, the default", () => {
    inLocale(<CompatRows view={view("fail")} />, "pl");
    expect(screen.getByText("Gra zaktualizowana z 1.0.16 do 1.0.20.")).toBeInTheDocument();
    expect(screen.getByText(/Nie da się odczytać 41 skrzyń: gra zapisuje ekwipunek w nowym formacie \(wersja 111\)/)).toBeInTheDocument();
    expect(screen.queryByText(/unreadable inventory/)).toBeNull();
    expect(screen.getAllByRole("img", { name: "nie działa" })).toHaveLength(1);
  });

  it("says when nothing was checked yet, and when a check runs", () => {
    const { rerender } = inLocale(<CompatRows view={{ running: false, result: null }} />);
    expect(screen.getByText(/Not checked yet/)).toBeInTheDocument();
    rerender(
      <I18nProvider locale="en">
        <CompatRows view={{ ...view("ok"), running: true }} />
      </I18nProvider>,
    );
    expect(screen.getByText(/Checking: waiting for the world/)).toBeInTheDocument();
  });

  it("words each known reason a container did not read, and passes a new one through", () => {
    const pl = makeI18n("pl");
    const en = makeI18n("en");
    expect(containerWhy(pl, "unreadable inventory: 70000 items")).toBe("skrzynia podaje 70000 przedmiotów, więcej niż się mieści");
    expect(containerWhy(en, "unreadable inventory: item flags 0x80")).toBe("an item has unknown flags (0x80)");
    expect(containerWhy(en, "unreadable inventory: 3 trailing bytes")).toBe("3 unknown bytes follow the last item");
    expect(containerWhy(pl, "truncated data")).toBe("zapis jest ucięty");
    expect(containerWhy(en, "bad varint")).toBe("bad varint");
  });

  it("shows an unknown reason code instead of nothing", () => {
    const v = view("ok");
    v.result!.checks[1] = { name: "save", status: "warn", reason: "something_new" };
    inLocale(<CompatRows view={v} />);
    expect(screen.getByText("Reported: something_new.")).toBeInTheDocument();
  });
});

describe("compatibility notice", () => {
  it("shows a failing or warning check to everyone, until dismissed on this device", () => {
    const store = memoryStorage();
    const onDetails = vi.fn();
    const { rerender, container } = inLocale(<CompatNotice view={view("fail")} onDetails={onDetails} />);
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Something broke after the game update to 1.0.20.");
    expect(notice).toHaveTextContent("Skald's check: World save.");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(onDetails).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(container).toBeEmptyDOMElement();
    expect(store.get("skald.compat.dismissed")).toBe(view("fail").result!.checkedAt);
    // A later check that still fails comes back.
    const later = mockCompat("warn", "l-1.0.20", 41, NOW + 3_600_000);
    rerender(
      <I18nProvider locale="en">
        <CompatNotice view={later} />
      </I18nProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Something needs a look after the game update to 1.0.20.");
    expect(screen.getByRole("status")).toHaveTextContent("Skald's check: Server log.");
  });

  it("stays away when all is fine, before any check, and without browser storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const { container, rerender } = inLocale(<CompatNotice view={view("ok")} />);
    expect(container).toBeEmptyDOMElement();
    for (const v of [view("pending"), view("none"), null]) {
      rerender(
        <I18nProvider locale="en">
          <CompatNotice view={v} />
        </I18nProvider>,
      );
      expect(container).toBeEmptyDOMElement();
    }
    rerender(
      <I18nProvider locale="pl">
        <CompatNotice view={view("fail")} />
      </I18nProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Po aktualizacji gry do 1.0.20 coś przestało działać.");
    // Storage blocked: dismissing still hides it for this visit.
    fireEvent.click(screen.getByRole("button", { name: "Ukryj" }));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("compatibility in the dashboard", () => {
  function fixture(compat: CompatView): ApiState {
    const s = emptyAgentState(new Date(NOW));
    s.server = { ...s.server, name: "My Valheim", world: "Midgard", status: "running", version: "l-1.0.20" };
    s.compat = compat;
    return { ...s, online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } };
  }
  const status: AdminStatus = {
    required: false,
    unlocked: true,
    idleMs: 1_800_000,
    notifyConfigured: false,
    bridge: { available: true, plugin: BRIDGE_PLUGIN_VERSION, gameBuild: "l-1.0.20", worldLoaded: true, timeFrozen: false, tested: true, acknowledged: false, testedBuilds: ["l-1.0.20"], commands: [] },
  };

  it("opens the admin sheet's check from the notice and runs it again", async () => {
    memoryStorage();
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u === "/api/admin/status") return Response.json(status);
        if (init?.method === "POST") {
          posts.push(u);
          return Response.json({ ok: true }, { status: 202 });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    // The section sits far down the sheet: 900 px below the top of its scrolling body.
    const rect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.id === "admin-compat-h" ? new DOMRect(0, 900, 100, 20) : rect.call(this);
    });
    let dialog: HTMLElement;
    let section: HTMLElement;
    try {
      render(<Dashboard live={{ state: fixture(view("fail")), logs: createLogStore(), online: true, lastAction: null }} onLogout={async () => "ok" as const} />);
      const notice = await screen.findByText("Something broke after the game update to 1.0.20.");
      fireEvent.click(within(notice.closest("[role=status]") as HTMLElement).getByRole("button", { name: "Details" }));
      dialog = await screen.findByRole("dialog", { name: "Admin" });
      section = within(dialog).getByRole("region", { name: "Game compatibility" });
      // Opened at the section, not at the top of the sheet.
      expect(section.closest<HTMLElement>("[data-sheet-body]")!.scrollTop).toBe(888);
    } finally {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockRestore();
    }
    expect(section).toHaveTextContent("something broke");
    expect(section).toHaveTextContent("41 containers cannot be read");
    await act(async () => {
      fireEvent.click(within(section).getByRole("button", { name: "Check again" }));
    });
    await waitFor(() => expect(posts).toEqual(["/api/admin/compat/run"]));
    expect(await screen.findByText("Checking again. The result shows here in a moment.")).toBeInTheDocument();
  });

  it("shows no section and no notice with an agent older than the check", async () => {
    memoryStorage();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url) === "/api/admin/status" ? Response.json(status) : new Response("{}", { status: 404 }))));
    const st = fixture(view("fail"));
    delete st.compat;
    render(<Dashboard live={{ state: st, logs: createLogStore(), online: true, lastAction: null }} onLogout={async () => "ok" as const} />);
    fireEvent.click(await screen.findByRole("button", { name: "Admin" }));
    const dialog = await screen.findByRole("dialog", { name: "Admin" });
    expect(within(dialog).queryByRole("region", { name: "Game compatibility" })).toBeNull();
    expect(screen.queryByText(/after the game update/)).toBeNull();
  });
});
