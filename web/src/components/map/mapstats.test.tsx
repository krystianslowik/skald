import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateMap } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { I18nProvider } from "../../i18n";
import MapView from "./MapView";
import { mapStatsOn } from "./MapCanvas";

// Its own file, so its own jsdom history: a sheet closed by another test steps back
// through history asynchronously, and landing mid-test drops ?mapstats from the URL.
const snap = gateMap(mockMap({ now: Date.parse("2026-10-10T20:00:00Z") }), false);

afterEach(() => vi.unstubAllGlobals());

describe("MapView", () => {
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
      await waitFor(() => expect(window.__mapStats).toBeTypeOf("function"));
      const s = window.__mapStats!();
      expect(s.view.scale).toBeGreaterThan(0);
      expect(s.ahead).toBeNull();
      withStats.unmount();
      expect(window.__mapStats).toBeUndefined();
    } finally {
      history.replaceState(null, "", "/");
    }
  });
});
