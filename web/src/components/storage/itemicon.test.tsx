import { render } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { iconCellStyle, setIconBuild, setIconSheetForTest, type IconSheet } from "../../lib/itemicons";
import { ItemIcon } from "./ItemIcon";

const SHEET: IconSheet = { url: "/api/icons/sheet.webp?v=b1", size: 64, width: 128, height: 128, items: { Wood: [0, 0], Stone: [64, 64] } };

afterEach(() => {
  act(() => setIconSheetForTest(null));
  vi.unstubAllGlobals();
});

describe("item icons", () => {
  it("places a cell by percent, so one style fits any box", () => {
    const st = iconCellStyle(SHEET, "Stone")!;
    expect(st.backgroundSize).toBe("200% 200%");
    expect(st.backgroundPosition).toBe("100% 100%");
    expect(iconCellStyle(SHEET, "Wood")!.backgroundPosition).toBe("0% 0%");
    expect(iconCellStyle(SHEET, "Nope")).toBeNull();
    // A one-cell sheet does not divide by zero.
    expect(iconCellStyle({ ...SHEET, width: 64, height: 64 }, "Wood")!.backgroundPosition).toBe("0% 0%");
  });

  it("draws the glyph without a sheet or for an item the sheet lacks, else the icon", () => {
    const { container, rerender } = render(<ItemIcon name="Wood" size={20} iconSize={28} />);
    expect(container.querySelector("svg")).not.toBeNull();
    act(() => setIconSheetForTest(SHEET));
    rerender(<ItemIcon name="Wood" size={20} iconSize={28} />);
    const span = container.querySelector<HTMLElement>("[data-item-icon='Wood']")!;
    expect(span).not.toBeNull();
    expect(span.style.width).toBe("28px");
    expect(span.style.backgroundImage).toContain("/api/icons/sheet.webp?v=b1");
    rerender(<ItemIcon name="Unknown" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("[data-item-icon]")).toBeNull();
  });

  it("loads map.json once per build and the sheet before switching over", async () => {
    const fetches: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetches.push(url);
        return new Response(JSON.stringify({ version: 1, build: "b2", size: 64, columns: 32, width: 2048, height: 64, count: 1, items: { Wood: [0, 0] } }));
      }),
    );
    const loaded: string[] = [];
    vi.stubGlobal(
      "Image",
      class {
        decoding = "";
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(v: string) {
          loaded.push(v);
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const { container } = render(<ItemIcon name="Wood" />);
    setIconBuild({ available: false, count: 0 });
    expect(fetches).toEqual([]);
    setIconBuild({ available: true, build: "b2", count: 1 });
    setIconBuild({ available: true, build: "b2", count: 1 });
    await vi.waitFor(() => expect(container.querySelector("[data-item-icon='Wood']")).not.toBeNull());
    expect(fetches).toEqual(["/api/icons/map.json"]);
    expect(loaded).toEqual(["/api/icons/sheet.webp?v=b2"]);
    // The agent loses its sheet: back to glyphs.
    act(() => setIconBuild(null));
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
