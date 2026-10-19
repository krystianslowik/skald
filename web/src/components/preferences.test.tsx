import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { mapPerf, setMapPerf } from "../lib/mapperf";
import { Preferences } from "./Preferences";

afterEach(() => {
  setMapPerf(false);
  localStorage.clear();
});

describe("Map performance mode switch", () => {
  it("is off by default, turns on, and is remembered on this device", () => {
    render(
      <I18nProvider locale="en">
        <Preferences onLogout={async () => "ok" as const} />
      </I18nProvider>,
    );
    const sw = screen.getByRole("switch", { name: "Map performance mode" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Plainer close-up map for weaker phones")).toBeInTheDocument();
    act(() => sw.click());
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(mapPerf()).toBe(true);
    expect(localStorage.getItem("skald_map_perf")).toBe("1");
  });

  it("is in Polish too", () => {
    render(
      <I18nProvider locale="pl">
        <Preferences onLogout={async () => "ok" as const} />
      </I18nProvider>,
    );
    expect(screen.getByRole("switch", { name: "Tryb wydajności mapy" })).toHaveAttribute("aria-checked", "false");
  });
});
