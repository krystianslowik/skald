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
import MapView, { TerrainFrame } from "./MapView";

const inLocale = (ui: ReactElement, locale: "en" | "pl" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);
const snap = gateMap(mockMap({ now: Date.parse("2026-10-10T20:00:00Z") }), false);
const markers = buildMarkers(snap, makeI18n("en").lookup);
const find = (f: (m: Marker) => boolean) => markers.find(f)!;

afterEach(() => vi.unstubAllGlobals());

describe("MapDetails", () => {
  it("tells how someone fell", () => {
    const grave = find((m) => m.data.type === "grave" && m.data.owner === "Bjorn");
    inLocale(<MapDetails marker={grave} seedName="ZbzIWkK5KK" onClose={() => {}} />);
    expect(screen.getByText("Bjorn fell on day 36")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Open on full map/ });
    expect(link).toHaveAttribute("href", `https://valheim-map.world/?seed=ZbzIWkK5KK&offset=${grave.x},${grave.z}&zoom=0.100&ver=1.0.7`);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("says where a portal leads and goes there", () => {
    const portal = find((m) => m.data.type === "portal" && m.data.tag === "mountain" && m.x < 1000);
    const onGo = vi.fn();
    inLocale(<MapDetails marker={portal} seedName="s" onGo={onGo} onClose={() => {}} />);
    expect(screen.getByText("Leads to mountain")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to the other end" }));
    expect(onGo).toHaveBeenCalledWith(1570, 1700);
  });

  it("names a portal without a partner and works in Polish", () => {
    const lone = find((m) => m.data.type === "portal" && !m.data.pairedWith);
    inLocale(<MapDetails marker={lone} seedName="s" onClose={() => {}} />, "pl");
    expect(screen.getByText("Niepołączony z żadnym portalem")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Przejdź na drugi koniec" })).not.toBeInTheDocument();
  });

  it("does not need names", () => {
    const hidden = buildMarkers(gateMap(mockMap({ showNames: false }), false), makeI18n("en").lookup);
    const grave = hidden.find((m) => m.data.type === "grave")!;
    inLocale(<MapDetails marker={grave} seedName="s" onClose={() => {}} />);
    expect(screen.getByText(/^Someone fell on day/)).toBeInTheDocument();
  });
});

describe("MapLayers", () => {
  function setup() {
    const toggles: LayerId[] = [];
    const picks: Marker[] = [];
    inLocale(
      <MapLayers
        map={snap}
        markers={markers}
        layers={DEFAULT_LAYERS}
        counts={layerCounts(markers, snap)}
        onToggle={(l) => toggles.push(l)}
        onPick={(m) => picks.push(m)}
        now={Date.parse("2026-10-10T20:00:00Z")}
      />,
    );
    return { toggles, picks };
  }

  it("lists layers with counts and toggles them", () => {
    const { toggles } = setup();
    const portals = screen.getByRole("button", { name: "Portals: shown" });
    expect(portals).toHaveAttribute("aria-pressed", "true");
    expect(within(portals).getByText("7")).toBeInTheDocument();
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

describe("TerrainFrame", () => {
  it("always offers the site in a new tab and credits it", () => {
    inLocale(<TerrainFrame seedName="ZbzIWkK5KK" />);
    expect(screen.getByText("Terrain by valheim-map.world")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open in a new tab/ })).toHaveAttribute("href", "https://valheim-map.world/?seed=ZbzIWkK5KK&ver=1.0.7");
    expect(screen.getByTitle("Terrain by valheim-map.world").tagName).toBe("IFRAME");
  });

  it("gives the note a full line of its own on a phone", () => {
    // jsdom has no layout, so this pins the classes: below `sm` the note takes the whole width under the
    // credit and the link instead of a word-per-line column between them (#58).
    inLocale(<TerrainFrame seedName="s" />, "pl");
    const note = screen.getByText(/^Zewnętrzna strona/);
    expect(note).toHaveClass("basis-full", "order-last", "sm:basis-0", "sm:flex-1", "sm:order-none");
    expect(note).not.toHaveClass("flex-1");
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
    inLocale(<MapView seedName="ZbzIWkK5KK" saveKey="a" now={Date.now()} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "World map" })).toBeInTheDocument();
    expect(await screen.findAllByRole("button", { name: "Portals: shown" })).not.toHaveLength(0);
    expect(screen.getByRole("img", { name: /World map. Drag to move/ })).toBeInTheDocument();
    // The terrain frame is not loaded until its tab is opened.
    expect(screen.queryByTitle("Terrain by valheim-map.world")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Terrain" }));
    expect(screen.getByTitle("Terrain by valheim-map.world")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("names the layers sheet's close button after the sheet, not the map", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snap)));
    inLocale(<MapView seedName="ZbzIWkK5KK" saveKey="a" now={Date.now()} onClose={vi.fn()} />, "pl");
    await screen.findAllByRole("button", { name: /Portale/ });
    fireEvent.click(screen.getByRole("button", { name: "Warstwy" }));
    const sheet = await screen.findByRole("dialog", { name: "Warstwy" });
    expect(within(sheet).getByRole("button", { name: "Zamknij warstwy" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Zamknij mapę" })).not.toBeInTheDocument();
  });

  it("explains a missing map", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    inLocale(<MapView seedName="" saveKey="b" now={Date.now()} onClose={() => {}} />);
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
