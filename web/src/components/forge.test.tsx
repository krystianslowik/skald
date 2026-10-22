import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { emptyAgentState, type Metrics, type SeriesPoint } from "../types";
import { Forge } from "./Forge";

const NOW = Date.parse("2026-10-09T20:00:00Z");
const GiB = 1024 ** 3;

/** Memory climbing to a 2.4 GiB peak and settling at 1.9 GiB now. */
function metrics(): Metrics {
  const memory: SeriesPoint[] = [
    [NOW - 120_000, 1.5 * GiB],
    [NOW - 60_000, 2.4 * GiB],
    [NOW, 1.9 * GiB],
  ];
  return { cpu: [[NOW, 0.5]], memory, rx: [[NOW, 1000]], tx: [[NOW, 500]] };
}

function forge(memoryLimitBytes: number | null | undefined, locale: "en" | "pl" = "en", m: Metrics | null = metrics()) {
  const s = emptyAgentState(new Date(NOW));
  const server = { ...s.server, memoryLimitBytes };
  if (memoryLimitBytes === undefined) delete server.memoryLimitBytes;
  return render(
    <I18nProvider locale={locale}>
      <Forge metrics={m} metricsConfigured server={server} world={s.world} />
    </I18nProvider>,
  );
}

const memoryMeter = async () => screen.findByRole("meter", { name: /^(Memory|Pamięć)$/ });

/** The "/ 6.0 GiB" after the value in the gauge's header, as text ("/" hidden, "of" for screen readers). */
const limitSuffix = (container: HTMLElement) => {
  const el = container.querySelector("h3 + span > span");
  return el ? el.textContent!.replace(/\s+/g, " ").trim() : null;
};

describe("Forge memory meter", () => {
  it("measures memory against the game container's limit and marks the 6-hour peak", async () => {
    const { container } = forge(6 * GiB);
    const meter = await memoryMeter();
    // 1.9 GiB of 6 GiB is 32 %, not 79 % of the peak; the limit reads as it was set.
    expect(meter).toHaveAttribute("aria-valuenow", "32");
    expect(meter).toHaveAttribute("aria-valuetext", "1.9 GiB now, 32% of the 6.0 GiB limit; 6-hour peak 2.4 GiB");
    expect(limitSuffix(container)).toBe("/ of 6.0 GiB");
    expect(container.querySelector("h3 + span > span > [aria-hidden]")).toHaveTextContent("/");
    const mark = container.querySelector<HTMLElement>("[data-testid=meter-peak]");
    expect(mark).not.toBeNull();
    expect(mark!.style.left).toContain("40%");
  });

  it("falls back to the 6-hour peak without a limit", async () => {
    for (const limit of [null, undefined, 0]) {
      const { container, unmount } = forge(limit);
      const meter = await memoryMeter();
      expect(meter).toHaveAttribute("aria-valuenow", "79");
      expect(meter).toHaveAttribute("aria-valuetext", "1.9 GiB now, 79% of the 6-hour peak");
      expect(container.querySelector("[data-testid=meter-peak]")).toBeNull();
      expect(limitSuffix(container)).toBeNull();
      unmount();
    }
  });

  it("leaves the limit out while Prometheus is silent", async () => {
    const { container } = forge(6 * GiB, "en", null);
    const meter = await memoryMeter();
    expect(meter).toHaveAttribute("aria-valuetext", "? now, 0% of the 6-hour peak");
    expect(container.querySelector("[data-testid=meter-peak]")).toBeNull();
    expect(limitSuffix(container)).toBeNull();
  });

  it("leaves the limit out before the first memory sample", async () => {
    const { container } = forge(6 * GiB, "en", { ...metrics(), memory: [] });
    const meter = await memoryMeter();
    expect(meter).toHaveAttribute("aria-valuetext", "0 B now, 0% of the 6-hour peak");
    expect(container.querySelector("[data-testid=meter-peak]")).toBeNull();
    expect(limitSuffix(container)).toBeNull();
  });

  it("says it in Polish", async () => {
    forge(6 * GiB, "pl");
    const meter = await memoryMeter();
    expect(meter.getAttribute("aria-valuetext")).toMatch(/^1,9 GiB teraz, 32% limitu 6,0 GiB; szczyt z ostatnich 6 godzin 2,4 GiB$/);
  });
});
