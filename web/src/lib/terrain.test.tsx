import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateMap } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { MapLayers } from "../components/map/MapLayers";
import { I18nProvider, makeI18n } from "../i18n";
import { buildMarkers, DEFAULT_LAYERS, layerCounts, LAYERS } from "./mapgeo";
import { loadTerrain } from "./useTerrain";

afterEach(() => vi.unstubAllGlobals());

const snap = gateMap(mockMap({ now: Date.parse("2026-10-10T20:00:00Z") }), false);
const markers = buildMarkers(snap, makeI18n("en").lookup);

describe("terrain layer", () => {
  it("is the bottom layer, on by default, without a count", () => {
    expect(LAYERS[0]).toBe("relief");
    expect(DEFAULT_LAYERS.relief).toBe(true);
    expect(layerCounts(markers, snap).relief).toBe(0);
  });

  it("loads the facts, then the image under its build", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => (urls.push(u), new Response(JSON.stringify({ build: "k9", radius: 10500, stale: false })))));
    vi.stubGlobal(
      "Image",
      class {
        decoding = "";
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(v: string) {
          urls.push(v);
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const r = await loadTerrain("a");
    expect(r.status).toBe("ready");
    expect(r.status === "ready" && r.relief.radius).toBe(10500);
    expect(urls).toEqual(["/api/terrain.json", "/api/terrain.png?v=k9"]);
    // Same key: no second request.
    await loadTerrain("a");
    expect(urls.length).toBe(2);
  });

  it("is none when the server has no terrain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect((await loadTerrain("b")).status).toBe("none");
  });

  it("shows its toggle only when there is terrain, and says when it is stale", () => {
    const panel = (relief: "none" | "ready" | "stale") => (
      <I18nProvider locale="en">
        <MapLayers map={snap} markers={markers} layers={DEFAULT_LAYERS} counts={layerCounts(markers, snap)} relief={relief} onToggle={() => {}} onPick={() => {}} />
      </I18nProvider>
    );
    const { rerender } = render(panel("none"));
    expect(screen.queryByText("Terrain")).toBeNull();
    rerender(panel("stale"));
    expect(screen.getByText("Terrain")).toBeTruthy();
    expect(screen.getByText(/older game build/)).toBeTruthy();
  });
});
