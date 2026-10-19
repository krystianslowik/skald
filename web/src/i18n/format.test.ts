import { afterEach, describe, expect, it, vi } from "vitest";
import { makeI18n } from "./index";

afterEach(() => vi.restoreAllMocks());

describe("date and time formatting", () => {
  const at = Date.UTC(2026, 9, 19, 18, 5, 9);
  const iso = new Date(at).toISOString();

  it.each(["en", "pl"] as const)("reads the same as the browser's own toLocale*String (%s)", (locale) => {
    const i = makeI18n(locale);
    const d = new Date(at);
    expect(i.clock(at)).toBe(d.toLocaleTimeString(i.intl, { hour: "2-digit", minute: "2-digit" }));
    expect(i.clockSec(iso)).toBe(d.toLocaleTimeString(i.intl, { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    expect(i.fullDate(iso)).toBe(d.toLocaleString(i.intl, { dateStyle: "medium", timeStyle: "short" }));
    expect(i.date(at)).toBe(d.toLocaleDateString(i.intl, { dateStyle: "medium" }));
    expect(i.dayLabel(iso, at + 5 * 86_400_000)).toBe(d.toLocaleDateString(i.intl, { weekday: "long", day: "numeric", month: "long" }));
  });

  // Building a formatter per call made a tab full of timestamps miss frames while it faded in.
  // toLocale*String with options builds one behind the scenes on every call.
  it("does not build a formatter per timestamp", () => {
    const i = makeI18n("en");
    const perCall = [
      vi.spyOn(Date.prototype, "toLocaleTimeString"),
      vi.spyOn(Date.prototype, "toLocaleString"),
      vi.spyOn(Date.prototype, "toLocaleDateString"),
    ];
    const built = vi.spyOn(Intl, "DateTimeFormat");
    for (let n = 0; n < 50; n++) {
      i.clock(at + n * 60_000);
      i.clockSec(at + n * 60_000);
      i.fullDate(at + n * 60_000);
      i.date(at + n * 60_000);
      i.dayLabel(new Date(at - n * 86_400_000).toISOString(), at);
    }
    for (const spy of perCall) expect(spy).not.toHaveBeenCalled();
    expect(built).not.toHaveBeenCalled();
  });

  it("shows a bad timestamp as before instead of throwing", () => {
    const i = makeI18n("en");
    expect(i.clockSec("")).toBe("Invalid Date");
    expect(i.fullDate("not a date")).toBe("Invalid Date");
    expect(i.date(Number.NaN)).toBe("Invalid Date");
  });
});
