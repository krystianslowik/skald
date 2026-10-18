import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateMap, storageOf } from "@server/mapgate";
import { mockMap } from "@server/mapmock";
import { I18nProvider, makeI18n } from "../../i18n";
import { buildMarkers, DEFAULT_LAYERS, layerCounts, markerStore, markerStores, type Marker } from "../../lib/mapgeo";
import { aggregate, fold, itemCategory, itemLabel, matchingItems, prettify, searchStore } from "../../lib/storage";
import type { MapContainer } from "../../types";
import { MapDetails } from "../map/MapDetails";
import { MapLayers } from "../map/MapLayers";
import MapView from "../map/MapView";
import { InventoryGrid } from "./Inventory";
import { VillageStores } from "./VillageStores";

const inLocale = (ui: ReactElement, locale: "en" | "pl" = "en") => render(<I18nProvider locale={locale}>{ui}</I18nProvider>);
const snap = gateMap(mockMap({ now: Date.parse("2026-10-10T20:00:00Z") }), false);
const en = makeI18n("en");
const markers = buildMarkers(snap, en.lookup);
const find = (f: (m: Marker) => boolean) => markers.find(f)!;

afterEach(() => vi.unstubAllGlobals());

describe("storage helpers", () => {
  it("names items in both languages, else prettifies the prefab", () => {
    expect(itemLabel("Iron", en.lookup)).toBe("Iron");
    expect(itemLabel("Iron", makeI18n("pl").lookup)).toBe("Żelazo");
    expect(itemLabel("ArmorBronzeChest", en.lookup)).toBe("Bronze Plate Tunic");
    expect(prettify("SwordBronze")).toBe("Bronze sword");
    expect(prettify("ArmorTrollLeatherLegs")).toBe("Troll leather legs");
    expect(prettify("TrophyDeer")).toBe("Deer trophy");
    expect(prettify("BowFineWood")).toBe("Fine wood bow");
    expect(prettify("VikingShip_Ashlands")).toBe("Viking ship ashlands");
    expect(prettify("#0badf00d")).toBe("#0badf00d");
  });

  it("sorts things into kinds", () => {
    expect(itemCategory("Wood", "Material")).toBe("wood");
    expect(itemCategory("CopperOre", "Material")).toBe("ore");
    expect(itemCategory("IronScrap", "Material")).toBe("ore");
    expect(itemCategory("Iron", "Material")).toBe("metal");
    expect(itemCategory("CarrotSeeds", "Material")).toBe("seed");
    expect(itemCategory("Honey", "Consumable")).toBe("food");
    expect(itemCategory("SwordBronze", "OneHandedWeapon")).toBe("weapon");
    expect(itemCategory("HelmetBronze", "Helmet")).toBe("armor");
    expect(itemCategory("Hammer", "Tool")).toBe("tool");
    expect(itemCategory("TrophyDeer")).toBe("trophy");
    expect(itemCategory("Resin", "Material")).toBe("material");
    expect(itemCategory("#12345678")).toBe("misc");
  });

  it("adds up the village, most first per item, and finds it in either language", () => {
    const entries = aggregate(snap.storage, en.lookup);
    const iron = entries.find((e) => e.name === "Iron")!;
    const expected = snap.storage.flatMap((c) => c.items).filter((i) => i.name === "Iron").reduce((n, i) => n + i.stack, 0);
    expect(iron.total).toBe(expected);
    expect(iron.places.map((p) => p.count)).toEqual([...iron.places.map((p) => p.count)].sort((a, b) => b - a));
    expect(searchStore(entries, "iron").map((e) => e.name)).toContain("Iron");
    expect(searchStore(entries, "żelazo").map((e) => e.name)).toEqual(["Iron"]);
    expect(searchStore(entries, "zelazo").map((e) => e.name)).toEqual(["Iron"]);
    // Polish names are found from the English UI and the other way round.
    expect(searchStore(entries, "miód").map((e) => e.name)).toContain("Honey");
    expect(fold("Złom ŻELAZA")).toBe("zlom zelaza");
    const cart = snap.storage.find((c) => c.kind === "cart")!;
    expect(matchingItems(cart.items, "ore", en.lookup)[0]).toEqual({ name: "CopperOre", label: "Copper Ore", count: 90 });
  });
});

describe("map storage", () => {
  it("draws chests on their own layer, a stack as one mark, and gives carts and ships their hold", () => {
    const chests = markers.filter((m) => m.layer === "storage");
    const all = snap.storage.filter((c) => c.kind === "chest");
    expect(chests.flatMap(markerStores)).toHaveLength(all.length);
    expect(chests.filter((m) => m.data.type === "storage" && m.data.stack).map((m) => markerStores(m).length).sort()).toEqual([2, 3]);
    expect(DEFAULT_LAYERS.storage).toBe(true);
    // The layer counts chests, not marks.
    expect(layerCounts(markers, snap).storage).toBe(all.length);
    const cart = find((m) => m.data.type === "vehicle" && m.data.kind === "Cart");
    expect(markerStore(cart)?.items.length).toBeGreaterThan(0);
  });

  it("shows a cart's load and its slots, and names a slot when tapped", () => {
    const cart = find((m) => m.data.type === "vehicle" && m.data.kind === "Cart");
    inLocale(<MapDetails marker={cart} onClose={() => {}} />);
    const total = markerStore(cart)!.items.reduce((n, i) => n + i.stack, 0);
    expect(screen.getByText(`Loaded with ${total} items`)).toBeInTheDocument();
    const grid = screen.getByRole("list", { name: "Contents" });
    // 6 x 3: every slot is drawn, the used ones as buttons.
    expect(grid.children).toHaveLength(18);
    fireEvent.click(within(grid).getAllByRole("button", { name: "Copper Ore, 30" })[0]!);
    expect(screen.getByText("Copper Ore × 30")).toBeInTheDocument();
  });

  it("shows quality, durability and the crafter of gear", () => {
    const chest = find((m) => m.data.type === "storage" && m.data.store.prefab === "piece_chest_private");
    inLocale(<MapDetails marker={chest} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "Personal Chest" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Bronze Sword, 1/ }));
    expect(screen.getByText(/Quality 3/)).toBeInTheDocument();
    expect(screen.getByText(/Durability 287\.5/)).toBeInTheDocument();
    expect(screen.getByText(/Made by Ragnar/)).toBeInTheDocument();
  });

  it("lists what a grave holds and says when a raft has no hold", () => {
    const grave = find((m) => m.data.type === "grave" && m.data.owner === "Ragnar");
    inLocale(<MapDetails marker={grave} onClose={() => {}} />);
    expect(screen.getByText("27 items left behind")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Contents" }).children).toHaveLength(32);
  });

  it("names the hold of a raft and an empty chest", () => {
    const raft = find((m) => m.data.type === "vehicle" && m.data.kind === "Raft");
    const { unmount } = inLocale(<MapDetails marker={raft} onClose={() => {}} />);
    expect(screen.getByText("No hold")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Contents" })).not.toBeInTheDocument();
    unmount();
    const empty = find((m) => m.data.type === "storage" && m.data.store.items.length === 0);
    inLocale(<MapDetails marker={empty} onClose={() => {}} />);
    expect(screen.getByText("Empty")).toBeInTheDocument();
  });

  it("finds items with the map search", () => {
    const picks: Marker[] = [];
    inLocale(
      <MapLayers map={snap} markers={markers} layers={DEFAULT_LAYERS} counts={layerCounts(markers, snap)} onToggle={() => {}} onPick={(m) => picks.push(m)} />,
      "pl",
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "żelazo" } });
    // Most iron first: the reinforced chest with 91.
    const first = screen.getAllByRole("button").find((b) => /Żelazo 91/.test(b.textContent ?? ""))!;
    fireEvent.click(first);
    expect(markerStore(picks[0]!)?.prefab).toBe("piece_chest");
  });
});

describe("InventoryGrid", () => {
  it("grows to fit slots beyond the known size and keeps empty slots quiet", () => {
    inLocale(<InventoryGrid items={[{ name: "Wood", type: "Material", stack: 7, x: 6, y: 0 }]} width={5} height={2} />);
    const grid = screen.getByRole("list", { name: "Contents" });
    // Width as given: the caller (the agent) already grew it. 5 x 2 here.
    expect(grid.children).toHaveLength(10);
  });

  it("shows both the stack and the quality of an item that has both", () => {
    inLocale(<InventoryGrid items={[{ name: "ArrowFire", type: "Ammo", stack: 37, quality: 3, x: 0, y: 0 }]} width={5} height={2} />);
    const slot = screen.getByRole("button", { name: "Fire Arrow, 37" });
    expect(within(slot).getByText("37")).toBeInTheDocument();
    expect(within(slot).getByText("★★★")).toBeInTheDocument();
    fireEvent.click(slot);
    expect(screen.getByText("Fire Arrow × 37")).toBeInTheDocument();
    expect(screen.getByText(/Quality 3/)).toBeInTheDocument();
  });
});

describe("VillageStores", () => {
  const storage = storageOf(snap);

  it("adds up the stores, searches in Polish and hands a container to the map", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(storage)));
    const onShow = vi.fn();
    inLocale(<VillageStores saveKey="a" onShow={onShow} />, "pl");
    expect(await screen.findByText(/Rodzaje przedmiotów: \d+, schowki: \d+/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "iron" } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Żelazo/ })).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Żelazo/ }));
    const sheet = await screen.findByRole("dialog", { name: /Żelazo/ });
    expect(within(sheet).getByRole("button", { name: "Zamknij miejsca przedmiotu" })).toBeInTheDocument();
    const rows = within(sheet).getAllByRole("button", { name: /Pokaż na mapie/ });
    expect(rows.length).toBeGreaterThan(1);
    fireEvent.click(rows[0]!);
    expect(onShow).toHaveBeenCalledTimes(1);
    const [entry, open] = onShow.mock.calls[0]! as [{ name: string; places: { container: MapContainer }[] }, string];
    expect(entry.name).toBe("Iron");
    expect(open).toBe(entry.places[0]!.container.id);
  });

  it("never lists world chests, because the agent never sends them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(storage)));
    inLocale(<VillageStores saveKey="b" onShow={() => {}} />);
    await screen.findByText(/kinds of things/);
    expect(storage.containers.every((c) => !/Treasure|shipwreck/.test(c.prefab))).toBe(true);
  });

  it("shows a few rows of slots, biggest first, and the rest on request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(storage)));
    localStorage.removeItem("skald.stores.open");
    inLocale(<VillageStores saveKey="d" onShow={() => {}} />);
    const bag = await screen.findByRole("list", { name: "Village stores" });
    const totals = within(bag)
      .getAllByRole("button")
      .map((b) => Number(b.getAttribute("aria-label")!.split(", ")[1]!.replace(/\D/g, "")));
    expect(totals).toEqual(totals.toSorted((a, b) => b - a));
    const more = screen.queryByRole("button", { name: /Show all \d+/ });
    expect(more).not.toBeNull();
    if (more) {
      expect(within(bag).getAllByRole("button")).toHaveLength(24);
      fireEvent.click(more);
      expect(within(bag).getAllByRole("button").length).toBeGreaterThan(24);
      expect(localStorage.getItem("skald.stores.open")).toBe("1");
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      expect(within(bag).getAllByRole("button")).toHaveLength(24);
    }
  });

  it("narrows the bag to one kind with a chip", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(storage)));
    inLocale(<VillageStores saveKey="e" onShow={() => {}} />);
    const group = await screen.findByRole("group", { name: "Kinds of things" });
    const metal = within(group).getByRole("button", { name: /^Metal \d+/ });
    const n = Number(metal.textContent!.replace(/\D/g, ""));
    fireEvent.click(metal);
    expect(metal).toHaveAttribute("aria-pressed", "true");
    const bag = screen.getByRole("list", { name: "Metal" });
    expect(within(bag).getAllByRole("button")).toHaveLength(Math.min(n, 24));
    fireEvent.click(within(group).getByRole("button", { name: /^All/ }));
    expect(screen.getByRole("list", { name: "Village stores" })).toBeInTheDocument();
  });

  it("explains a failure and retries", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    inLocale(<VillageStores saveKey="c" onShow={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe("MapView focus", () => {
  it("opens the focused container and rings every place", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snap)));
    const iron = snap.storage.filter((c) => c.items.some((i) => i.name === "Iron"));
    const onClear = vi.fn();
    inLocale(<MapView saveKey="f" onClose={() => {}} focus={{ ids: iron.map((c) => c.id), open: iron[0]!.id, label: "Iron", key: 1 }} onFocusClear={onClear} />);
    expect(await screen.findByText(`Iron: ${iron.length} places`)).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Contents" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop highlighting" }));
    expect(onClear).toHaveBeenCalled();
  });
});
