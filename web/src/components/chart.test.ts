import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chartTicks } from "./Chart";

const DAY = 86_400_000;

describe("chartTicks across the autumn DST change", () => {
  beforeAll(() => {
    vi.stubEnv("TZ", "Europe/Berlin");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("puts one day tick on every local midnight over 2026-10-25", () => {
    // The zone really is Berlin: CEST before the change, CET after.
    expect(new Date("2026-10-24T12:00:00Z").getTimezoneOffset()).toBe(-120);
    expect(new Date("2026-10-26T12:00:00Z").getTimezoneOffset()).toBe(-60);

    const t1 = new Date("2026-10-28T12:00:00+01:00").getTime();
    const ticks = chartTicks(t1 - 7 * DAY, t1, DAY);
    const days = ticks.map((t) => {
      const d = new Date(t);
      return `${d.getDate()}.${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    });
    expect(days).toEqual(["22.10 0:00", "23.10 0:00", "24.10 0:00", "25.10 0:00", "26.10 0:00", "27.10 0:00", "28.10 0:00"]);
    const labels = ticks.map((t) => new Date(t).toLocaleDateString("en-GB", { weekday: "short" }));
    expect(labels).toEqual(["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"]);
  });

  it("keeps hour ticks on a fixed step", () => {
    const t0 = new Date("2026-10-24T22:30:00+02:00").getTime();
    const ticks = chartTicks(t0, t0 + 12 * 3_600_000, 6 * 3_600_000);
    const first = new Date("2026-10-25T00:00:00+02:00").getTime();
    expect(ticks).toEqual([first, first + 6 * 3_600_000]);
  });
});
