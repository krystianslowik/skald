import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateMap } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { I18nProvider, makeI18n } from "../../i18n";
import { buildMarkers, DEFAULT_LAYERS, layerCounts, type LayerId, type Marker } from "../../lib/mapgeo";
import { WorldClock } from "../WorldClock";
import { MapDetails } from "./MapDetails";
import { MapLayers } from "./MapLayers";
import { OrePopover } from "./OrePopover";
import MapView from "./MapView";
import { mapStatsOn } from "./MapCanvas";
import { setMapPerf } from "../../lib/mapperf";

const inLocale = (ui: ReactElement, locale: "en" | "pl" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);
const snap = gateMap(mockMap({ now: Date.parse("2026-10-10T20:00:00Z") }), false);
const markers = buildMarkers(snap, makeI18n("en").lookup);
const find = (f: (m: Marker) => boolean) => markers.find(f)!;

afterEach(() => vi.unstubAllGlobals());

describe("MapDetails", () => {
  it("tells how someone fell", () => {
    const grave = find((m) => m.data.type === "grave" && m.data.owner === "Bjorn");
    inLocale(<MapDetails marker={grave} onClose={() => {}} />);
    expect(screen.getByText("Bjorn fell on day 36")).toBeInTheDocument();
    // The details sit on our own map already: no way off the panel (#151).
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("says where a portal leads and goes there", () => {
    const portal = find((m) => m.data.type === "portal" && m.data.tag === "mountain" && m.x < 1000);
    const onGo = vi.fn();
    inLocale(<MapDetails marker={portal} onGo={onGo} onClose={() => {}} />);
    expect(screen.getByText("Leads to mountain")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to the other end" }));
    expect(onGo).toHaveBeenCalledWith(1570, 1700);
  });

  it("names a portal without a partner and works in Polish", () => {
    const lone = find((m) => m.data.type === "portal" && !m.data.pairedWith);
    inLocale(<MapDetails marker={lone} onClose={() => {}} />, "pl");
    expect(screen.getByText("Niepołączony z żadnym portalem")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Przejdź na drugi koniec" })).not.toBeInTheDocument();
  });

  it("does not need names", () => {
    const hidden = buildMarkers(gateMap(mockMap({ showNames: false }), false), makeI18n("en").lookup);
    const grave = hidden.find((m) => m.data.type === "grave")!;
    inLocale(<MapDetails marker={grave} onClose={() => {}} />);
    expect(screen.getByText(/^Someone fell on day/)).toBeInTheDocument();
  });
});

describe("MapLayers", () => {
  function setup(relief?: "none" | "ready", locale: "en" | "pl" = "en") {
    const toggles: LayerId[] = [];
    const picks: Marker[] = [];
    inLocale(
      <MapLayers
        map={snap}
        markers={markers}
        relief={relief}
        layers={DEFAULT_LAYERS}
        counts={layerCounts(markers, snap)}
        onToggle={(l) => toggles.push(l)}
        onPick={(m) => picks.push(m)}
      />,
      locale,
    );
    return { toggles, picks };
  }

  it("has contour lines on by default, under the terrain, and only when there is terrain", () => {
    const { toggles } = setup("ready");
    const contours = screen.getByRole("button", { name: "Contour lines: shown" });
    expect(contours).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(contours);
    expect(toggles).toEqual(["contours"]);
    const rows = screen.getAllByRole("button", { name: /: (shown|hidden)$/ }).map((b) => b.getAttribute("aria-label"));
    expect(rows.indexOf("Contour lines: shown")).toBe(rows.indexOf("Terrain: shown") + 1);
  });

  it("names contour lines in Polish", () => {
    setup("ready", "pl");
    expect(screen.getAllByRole("button", { name: /^Poziomice/ })).toHaveLength(1);
  });

  it("greys out contour lines in performance mode, where they are not drawn", () => {
    setMapPerf(true);
    try {
      setup("ready");
      expect(screen.getByRole("button", { name: "Contour lines: shown" })).toBeDisabled();
    } finally {
      setMapPerf(false);
    }
  });

  it("has no contour row without terrain", () => {
    setup("none");
    expect(screen.queryByRole("button", { name: /Contour lines/ })).not.toBeInTheDocument();
  });

  it("lists layers with counts and toggles them", () => {
    const { toggles } = setup();
    const portals = screen.getByRole("button", { name: "Portals: shown" });
    expect(portals).toHaveAttribute("aria-pressed", "true");
    expect(within(portals).getByText("9")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beds: hidden" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(portals);
    expect(toggles).toEqual(["portals"]);
    expect(screen.getByText(/places nobody has found are hidden/)).toBeInTheDocument();
  });

  it("searches and picks", () => {
    const { picks } = setup();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bjorn" } });
    fireEvent.click(screen.getByRole("button", { name: "Grave" }));
    expect(picks[0]?.data.type).toBe("grave");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    expect(screen.getByText("Nothing by that name on the map.")).toBeInTheDocument();
  });
});

describe("WorldClock", () => {
  it("shows the day, the phase and a sleeping world", () => {
    inLocale(<WorldClock clock={{ netTime: 1800 * 7 + 1500, day: 7, dayFraction: 0.83, daylight: false, advancing: false, rate: 0 }} />);
    expect(screen.getByText("Day 7")).toBeInTheDocument();
    expect(screen.getByText("World asleep")).toBeInTheDocument();
    expect(screen.getByText(/Night/)).toBeInTheDocument();
  });
  it("falls back to the save's day", () => {
    inLocale(<WorldClock day={3} />);
    expect(screen.getByText("Day 3")).toBeInTheDocument();
    expect(screen.queryByText("World asleep")).not.toBeInTheDocument();
  });
});

describe("MapView", () => {
  it("loads the map and closes on Escape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snap)));
    const onClose = vi.fn();
    inLocale(<MapView saveKey="a" onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "World map" })).toBeInTheDocument();
    expect(await screen.findAllByRole("button", { name: "Portals: shown" })).not.toHaveLength(0);
    expect(screen.getByRole("img", { name: /World map. Drag to move/ })).toBeInTheDocument();
    // One map, ours: no tabs, no third-party frame (#151).
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("names the layers sheet's close button after the sheet, not the map", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snap)));
    inLocale(<MapView saveKey="a" onClose={vi.fn()} />, "pl");
    await screen.findAllByRole("button", { name: /Portale/ });
    fireEvent.click(screen.getByRole("button", { name: "Warstwy" }));
    const sheet = await screen.findByRole("dialog", { name: "Warstwy" });
    expect(within(sheet).getByRole("button", { name: "Zamknij warstwy" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Zamknij mapę" })).not.toBeInTheDocument();
  });

  it("offers the perf harness hook only under ?mapstats, and takes it away on close", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snap)));
    expect(mapStatsOn("?mapstats")).toBe(true);
    expect(mapStatsOn("?map=canvas&mapstats=1")).toBe(true);
    expect(mapStatsOn("?map=canvas")).toBe(false);
    const onClose = vi.fn();
    // The hook comes from a passive effect, which under load can still be pending when the buttons are in the DOM (#134).
    // Rendering the same tree again commits, and every commit first runs the effects still pending from the last one.
    const mounted = async () => {
      const ui = (
        <I18nProvider locale="en">
          <MapView saveKey="a" onClose={onClose} />
        </I18nProvider>
      );
      const r = render(ui);
      await screen.findAllByRole("button", { name: "Portals: shown" });
      r.rerender(ui);
      return r;
    };
    const plain = await mounted();
    expect(window.__mapStats).toBeUndefined();
    plain.unmount();
    history.replaceState(null, "", "/?mapstats");
    try {
      const withStats = await mounted();
      const s = window.__mapStats!();
      expect(s.view.scale).toBeGreaterThan(0);
      expect(s.ahead).toBeNull();
      withStats.unmount();
      expect(window.__mapStats).toBeUndefined();
    } finally {
      history.replaceState(null, "", "/");
    }
  });

  it("explains a missing map", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    inLocale(<MapView saveKey="b" onClose={() => {}} />);
    expect(await screen.findByText(/No world map/)).toBeInTheDocument();
  });
});

describe("OrePopover", () => {
  const copper = { category: "ore" as const, species: "copper", x: 268.4, z: -128.6, yaw: 30, size: 6.6 };

  it("names the deposit, what it yields and where, and closes", () => {
    const onClose = vi.fn();
    inLocale(<OrePopover ore={copper} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Copper deposit" })).toBeInTheDocument();
    expect(screen.getByText("Yields Copper Ore")).toBeInTheDocument();
    expect(screen.getByText("at x 268, z -129")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("speaks Polish and copes with a deposit it has no name for", () => {
    inLocale(<OrePopover ore={{ ...copper, species: "tin" }} onClose={() => {}} />, "pl");
    expect(screen.getByRole("dialog", { name: "Złoże cyny" })).toBeInTheDocument();
    expect(screen.getByText("Daje: Ruda cyny")).toBeInTheDocument();
    inLocale(<OrePopover ore={{ ...copper, species: "moonstone" }} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Ore deposit" })).toBeInTheDocument();
  });
});
