import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { gateMap } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { I18nProvider, makeI18n } from "../../i18n";
import { buildMarkers } from "../../lib/mapgeo";
import type { ApiMap } from "../../types";
import type { WebPin } from "@server/pintypes";
import type { MapCanvasHandle } from "./MapCanvas";
import { distance, PortalSheet, usePortalNet, type PortalNet } from "./PortalNetwork";

/** The hook's state, for tests that act on it the way the map does (a tap while picking). */
let lastNet: PortalNet | null = null;

function Harness({ map, canvas, onRing, webPins }: { map: ApiMap; canvas: React.RefObject<MapCanvasHandle | null>; onRing: (ids: readonly string[]) => void; webPins?: WebPin[] }) {
  const markers = buildMarkers(map, makeI18n("en").lookup);
  const net = usePortalNet(map, markers, webPins);
  lastNet = net;
  return <PortalSheet map={map} markers={markers} net={net} canvas={canvas} onRing={onRing} onClose={() => {}} />;
}

function setup(map: ApiMap, locale: "en" | "pl" = "en", webPins?: WebPin[]) {
  const flyTo = vi.fn();
  const canvas = createRef<MapCanvasHandle>() as { current: MapCanvasHandle | null };
  canvas.current = { flyTo, reveal: vi.fn(), zoomBy: vi.fn(), fit: vi.fn(), project: () => [0, 0], storeyAt: () => null };
  const onRing = vi.fn();
  render(
    <I18nProvider locale={locale}>
      <Harness map={map} canvas={canvas} onRing={onRing} webPins={webPins} />
    </I18nProvider>,
  );
  return { flyTo, onRing };
}

const named = () => gateMap(mockMap({ now: Date.parse("2026-10-10T20:00:00Z") }), false);

describe("PortalSheet", () => {
  it("lists what is wrong with the portals and rings one on tap", () => {
    const { flyTo, onRing } = setup(named());
    const warn = screen.getByRole("region", { name: "Warnings" });
    expect(within(warn).getByText("3 portals lead nowhere")).toBeInTheDocument();
    expect(within(warn).getByText("Tag “outpost” is on 3 portals: only one pair of them connects")).toBeInTheDocument();
    expect(within(warn).getByText("1 portal has no tag")).toBeInTheDocument();
    const list = screen.getByRole("region", { name: "Portals by tag" });
    fireEvent.click(within(list).getAllByRole("button", { name: /Portal “home”/ })[0]!);
    expect(flyTo).toHaveBeenCalled();
    expect(onRing).toHaveBeenLastCalledWith(["portal:-1450,1000", "portal:236,-322"]);
  });

  it("finds a route through a portal from the main base", () => {
    setup(named());
    // The swamp base is across the map from home; the home portal pair goes there.
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "base:1" } });
    const route = screen.getByRole("region", { name: "Route finder" });
    expect(within(route).getByText(/on foot, 1 portal$/)).toBeInTheDocument();
    expect(within(route).getByText(/^Step through to Portal “home”/)).toBeInTheDocument();
  });

  it("keeps to tag-free checks when names are hidden, in Polish", () => {
    setup(gateMap(mockMap({ showNames: false }), false), "pl");
    expect(screen.getByText(/Ten serwer ukrywa nazwy/)).toBeInTheDocument();
    expect(screen.getByText("3 portale nie prowadzą nigdzie")).toBeInTheDocument();
    expect(screen.queryByText(/nie ma nazwy|nie mają nazwy/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pary portali" })).toBeInTheDocument();
  });

  it("drops the destination when it becomes the start", () => {
    setup(named());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "base:1" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "base:1" } });
    expect((screen.getByLabelText("To") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByText(/on foot/)).not.toBeInTheDocument();
  });

  it("rounds before it picks metres or kilometres", () => {
    const { t, number } = makeI18n("en");
    expect(distance(994, t, number)).toBe("990 m");
    expect(distance(996, t, number)).toBe("1 km");
  });

  it("starts at a tapped base by its name, not as a bare point", () => {
    const map = named();
    setup(map);
    const markers = buildMarkers(map, makeI18n("en").lookup);
    const swamp = markers.find((m) => m.id === "base:1")!;
    act(() => lastNet!.setPicking(true));
    act(() => lastNet!.onTap(swamp));
    expect((screen.getByLabelText("From") as HTMLSelectElement).value).toBe("base:1");
    expect(lastNet!.start?.label).toBe("Base near Swamp camp");
  });

  it("shows nothing for a route that goes nowhere", () => {
    const map = named();
    setup(map);
    const markers = buildMarkers(map, makeI18n("en").lookup);
    const pin = markers.find((m) => m.data.type === "pin")!;
    // A tapped point right on the destination: no legs, so no route and no "0 m".
    act(() => lastNet!.onTap({ x: pin.x, z: pin.z }));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: pin.id } });
    expect(lastNet!.route).toBeNull();
    expect(screen.queryByText(/on foot/)).not.toBeInTheDocument();
  });

  it("does not offer an altar the game has not placed, even if it lies in explored land", () => {
    const map = named();
    const ghost = { kind: "boss" as const, name: "Dragonqueen", x: 40, z: 40, placed: false, explored: true };
    setup({ ...map, locations: [...map.locations, ghost] });
    const bosses = within(screen.getByLabelText("To")).getByRole("group", { name: "Boss altars" });
    expect(within(bosses).queryByText(/Moder/)).not.toBeInTheDocument();
  });

  it("offers the shared pins of the world as destinations", () => {
    const pin = (id: string, note: string, x: number, z: number): WebPin => ({ id, x, z, icon: "dungeon", note, author: "Ragnar", version: 1, createdAt: 1, updatedAt: 1, state: "new", claimedBy: null, stateBy: "Ragnar", stateAt: 1, archived: false });
    setup(named(), "en", [pin("w1", "Crypt by the river", 1200, -800), { ...pin("w2", "", 40, 60), icon: "ore" }]);
    const pins = within(screen.getByLabelText("To")).getByRole("group", { name: "Pins" });
    expect(within(pins).getByRole("option", { name: "Crypt by the river" })).toBeInTheDocument();
    expect(within(pins).getByRole("option", { name: /^Ore or mine x 40/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "webpin:w1" } });
    expect(within(screen.getByRole("region", { name: "Route finder" })).getAllByText(/on foot/).length).toBeGreaterThan(0);
  });

  it("offers only found boss altars", () => {
    const map = named();
    setup(map);
    const to = screen.getByLabelText("To");
    const bosses = within(to).getByRole("group", { name: "Boss altars" });
    const found = map.locations.filter((l) => l.kind === "boss" && l.explored).length;
    expect(within(bosses).getAllByRole("option")).toHaveLength(found);
  });
});
