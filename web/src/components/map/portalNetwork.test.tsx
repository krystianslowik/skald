import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { gateMap } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { I18nProvider, makeI18n } from "../../i18n";
import { buildMarkers } from "../../lib/mapgeo";
import type { ApiMap } from "../../types";
import type { MapCanvasHandle } from "./MapCanvas";
import { distance, PortalSheet, usePortalNet } from "./PortalNetwork";

function Harness({ map, canvas, onRing }: { map: ApiMap; canvas: React.RefObject<MapCanvasHandle | null>; onRing: (ids: readonly string[]) => void }) {
  const markers = buildMarkers(map, makeI18n("en").lookup);
  const net = usePortalNet(map, markers);
  return <PortalSheet map={map} markers={markers} net={net} canvas={canvas} onRing={onRing} onClose={() => {}} />;
}

function setup(map: ApiMap, locale: "en" | "pl" = "en") {
  const flyTo = vi.fn();
  const canvas = createRef<MapCanvasHandle>() as { current: MapCanvasHandle | null };
  canvas.current = { flyTo, reveal: vi.fn(), zoomBy: vi.fn(), fit: vi.fn(), project: () => [0, 0], storeyAt: () => null };
  const onRing = vi.fn();
  render(
    <I18nProvider locale={locale}>
      <Harness map={map} canvas={canvas} onRing={onRing} />
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

  it("offers only found boss altars", () => {
    const map = named();
    setup(map);
    const to = screen.getByLabelText("To");
    const bosses = within(to).getByRole("group", { name: "Boss altars" });
    const found = map.locations.filter((l) => l.kind === "boss" && l.explored).length;
    expect(within(bosses).getAllByRole("option")).toHaveLength(found);
  });
});
