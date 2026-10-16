import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateMap, storageOf } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { en } from "../../i18n/en";
import { I18nProvider, makeI18n } from "../../i18n";
import { pl } from "../../i18n/pl";
import { buildMarkers } from "../../lib/mapgeo";
import { MapDetails } from "../map/MapDetails";
import { StoreySwitcher } from "../map/StoreySwitcher";
import { StackLevel } from "./StackLevel";
import { VillageStores } from "./VillageStores";

const inLocale = (ui: ReactElement, locale: "en" | "pl" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);
const snap = gateMap(mockMap({ now: Date.parse("2026-10-10T20:00:00Z") }), false);
const markers = buildMarkers(snap, makeI18n("en").lookup);
const stackOf3 = markers.find((m) => m.data.type === "storage" && m.data.stack?.length === 3)!;

afterEach(() => vi.unstubAllGlobals());

describe("StackLevel", () => {
  it("says where a chest sits, in both languages", () => {
    const { unmount } = inLocale(
      <>
        <StackLevel index={2} total={3} />
        <StackLevel index={0} total={2} />
        <StackLevel index={1} total={3} />
        <StackLevel index={10} total={12} />
      </>,
    );
    expect(screen.getByText("3rd from the bottom of 3")).toBeInTheDocument();
    expect(screen.getByText("1st from the bottom of 2")).toBeInTheDocument();
    expect(screen.getByText("2nd from the bottom of 3")).toBeInTheDocument();
    expect(screen.getByText("11th from the bottom of 12")).toBeInTheDocument();
    unmount();
    inLocale(<StackLevel index={2} total={3} />, "pl");
    expect(screen.getByText("3. od dołu z 3")).toBeInTheDocument();
  });

  it("does not guess a level without heights (an older agent)", () => {
    inLocale(<StackLevel index={1} total={3} ordered={false} />);
    expect(screen.getByText("One of 3 on this spot")).toBeInTheDocument();
  });

  it("has every new key in both languages", () => {
    const keys = ["map.layer.buildings", "map.storeys", "map.storey.ground", "map.storey.floor", "map.storey.roof", "stack.title", "stack.level", "stack.unknown", "nth.one", "nth.two", "nth.few", "nth.other"];
    for (const k of keys) {
      expect(en).toHaveProperty([k]);
      expect(pl).toHaveProperty([k]);
    }
  });
});

describe("a stack on the map", () => {
  it("is one mark, opened as its chests stand, top first, with the picked one marked", () => {
    expect(stackOf3.data.type === "storage" && stackOf3.data.stack!.map((c) => c.y)).toEqual([31.7, 32.6, 33.5]);
    inLocale(<MapDetails marker={stackOf3} level={2} seedName="s" onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "Stack of 3 chests" })).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem").filter((li) => li.parentElement?.tagName === "OL");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("3rd from the bottom of 3")).toBeInTheDocument();
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(within(rows[2]!).getByText("1st from the bottom of 3")).toBeInTheDocument();
    // Each chest's own slots.
    expect(screen.getAllByRole("list", { name: "Contents" })).toHaveLength(3);
    // Like every other mark, the stack opens on the full map.
    expect(screen.getByRole("link", { name: /Open on full map/ })).toHaveAttribute("href", expect.stringContaining(`offset=${stackOf3.x},${stackOf3.z}`));
  });

  it("puts the lowest of two chests last, labelled 1st from the bottom, whatever order they arrive in", () => {
    // As a save gives them: two wood chests, one on the other, pivots 0.9 m apart and a little off-centre.
    const chest = (id: string, x: number, z: number, y: number, item: string) => ({ id, kind: "chest" as const, prefab: "piece_chest_wood", x, z, y, width: 5, height: 2, items: [{ name: item, stack: 10, x: 0, y: 0 }] });
    const top = chest("piece_chest_wood@40,-12#1", 40.15, -11.9, 32.75, "Resin");
    const bottom = chest("piece_chest_wood@40,-12", 40.1, -12.05, 31.85, "Stone");
    const map = { ...snap, storage: [top, bottom] };
    const mark = buildMarkers(map, makeI18n("pl").lookup).find((m) => m.data.type === "storage" && m.data.stack)!;
    inLocale(<MapDetails marker={mark} seedName="s" onClose={() => {}} />, "pl");
    const rows = screen.getAllByRole("listitem").filter((li) => li.parentElement?.tagName === "OL");
    expect(rows.map((r) => within(r).getByText(/od dołu/).textContent)).toEqual(["2. od dołu z 2", "1. od dołu z 2"]);
    expect(within(rows[1]!).getByRole("list", { name: "Zawartość" })).toHaveTextContent(/Kamień|10/);
    expect(within(rows[0]!).queryByLabelText(/Kamień/)).toBeNull();
  });

  it("names the level in the stores' where sheet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(storageOf(snap))));
    inLocale(<VillageStores saveKey="s" onShow={() => {}} />, "pl");
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "krzemień" } });
    fireEvent.click((await screen.findAllByRole("button", { name: /Krzemień/ }))[0]!);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("3. od dołu z 3")).toBeInTheDocument();
  });
});

describe("StoreySwitcher", () => {
  it("lists the storeys top down and moves with the arrow keys", () => {
    const picks: number[] = [];
    inLocale(<StoreySwitcher info={{ base: "b", storeys: 3, hasRoof: true, main: 0 }} level={0} onChange={(l) => picks.push(l)} />, "pl");
    const group = screen.getByRole("radiogroup", { name: "Kondygnacje" });
    expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Dach", "2. piętro", "1. piętro", "Parter"]);
    expect(within(group).getByRole("radio", { name: "Parter" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(group, { key: "ArrowUp" });
    fireEvent.keyDown(group, { key: "End" });
    fireEvent.click(within(group).getByRole("radio", { name: "1. piętro" }));
    expect(picks).toEqual([1, 3, 1]);
  });

  it("names English floors with ordinals", () => {
    inLocale(<StoreySwitcher info={{ base: "b", storeys: 2, hasRoof: false, main: 0 }} level={1} onChange={() => {}} />);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["1st floor", "Ground"]);
    expect(screen.getByRole("radio", { name: "1st floor" })).toHaveAttribute("tabindex", "0");
  });
});
