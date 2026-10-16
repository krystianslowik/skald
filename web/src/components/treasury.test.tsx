import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider, makeI18n } from "../i18n";
import type { Backup } from "../types";
import { Treasury } from "./Treasury";

// Built from local components, so the expected time holds in any time zone.
const at = new Date(2026, 9, 16, 15, 3).toISOString();
const earlier = new Date(2026, 9, 16, 9, 3).toISOString();
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

describe("backup timestamps", () => {
  it("formats the date and the time separately, in both languages", () => {
    const en = makeI18n("en");
    const pl = makeI18n("pl");
    expect(plain(en.date(at))).toBe("16 Oct 2026");
    expect(plain(pl.date(at))).toBe("16 paź 2026");
    for (const i of [en, pl]) {
      expect(i.date(at)).not.toMatch(/:/);
      expect(i.clock(at)).toBe("15:03");
    }
  });

  it("keeps the exact time of every backup on screen, with no clipping", () => {
    const rows: [Backup, string][] = [
      [{ name: "worlds-20261016-150300.zip", sizeBytes: 41_000_000, modifiedAt: at }, "15:03"],
      [{ name: "worlds-20261016-090300.zip", sizeBytes: 39_000_000, modifiedAt: earlier }, "09:03"],
    ];
    render(
      <I18nProvider locale="pl">
        <Treasury backups={rows.map(([b]) => b)} now={Date.parse(at) + 3_600_000} />
      </I18nProvider>,
    );
    for (const [b, time] of rows) {
      const stamp = document.querySelector(`time[datetime="${b.modifiedAt}"]`);
      expect(stamp).not.toBeNull();
      expect(plain(stamp!.textContent ?? "")).toBe(`16 paź 2026 ${time}`);
      expect(stamp!.getAttribute("title")).toMatch(time);
      const name = screen.getByText(b.name);
      expect(name).not.toHaveClass("truncate");
      expect(stamp).not.toHaveClass("truncate");
    }
  });
});
