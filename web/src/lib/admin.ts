// The admin bridge from the browser: status, the admin session, commands and
// the per-device things (the name in the saga, saved kits).

import type { TextKey } from "../i18n";
import type { AdminCatalog, AdminCommand, AdminRead, AdminResult, AdminStatus, BanEntry, LivePlayer } from "../types";
import { Unauthorized } from "./api";

/** A command's outcome; `status` 403 + `needsAdmin` means: unlock first. */
export interface AdminOutcome extends AdminResult {
  status: number;
  needsAdmin?: boolean;
}

const NAME_KEY = "skald.admin.name";
const KITS_KEY = "skald.admin.kits";

/** The name this device signs admin actions with in the saga; empty: a session hash. */
export function storedActorName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeActorName(name: string): void {
  try {
    if (name.trim()) localStorage.setItem(NAME_KEY, name.trim().slice(0, 40));
    else localStorage.removeItem(NAME_KEY);
  } catch {
    // not remembered; fine
  }
}

async function json<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getAdminStatus(): Promise<AdminStatus> {
  const res = await fetch("/api/admin/status", { credentials: "same-origin" });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AdminStatus;
}

export type UnlockResult = { ok: true } | { ok: false; retryAfter?: number };

export async function unlockAdmin(password: string): Promise<UnlockResult> {
  const res = await fetch("/api/admin/unlock", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) return { ok: true };
  // A wrong admin password is "invalid"; an expired panel session is "unauthorized".
  if (res.status === 401 && (await json<{ error?: string }>(res))?.error === "unauthorized") throw new Unauthorized();
  if (res.status === 429) return { ok: false, retryAfter: Number(res.headers.get("Retry-After")) || 900 };
  return { ok: false };
}

export async function lockAdmin(): Promise<void> {
  await fetch("/api/admin/lock", { method: "POST", credentials: "same-origin" });
}

function outcome(status: number, body: AdminResult | null, fallback: string): AdminOutcome {
  const b = body ?? { ok: false, error: fallback };
  const needsAdmin = status === 403 && (b as { error?: string }).error === "admin_required";
  return { ...b, ok: status === 200 && b.ok !== false, status, needsAdmin };
}

/** POST /api/admin/{command}; the name rides along URI-encoded (header values are bytes). */
export async function runAdmin(command: AdminCommand, body: Record<string, unknown> = {}): Promise<AdminOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/${command}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Skald-Name": encodeURIComponent(storedActorName()) },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: "offline" };
  }
  if (res.status === 401) throw new Unauthorized();
  return outcome(res.status, await json<AdminResult>(res), `HTTP ${res.status}`);
}

/** POST /api/notify/test: one test message to the Discord webhook. */
export async function testNotify(): Promise<AdminOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/notify/test", { method: "POST", credentials: "same-origin" });
  } catch {
    return { ok: false, status: 0, error: "offline" };
  }
  if (res.status === 401) throw new Unauthorized();
  return outcome(res.status, await json<AdminResult>(res), `HTTP ${res.status}`);
}

async function getAdmin<T>(path: string): Promise<{ status: number; data: T | null; error?: string; needsAdmin?: boolean }> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (res.status === 401) throw new Unauthorized();
  const body = await json<AdminResult & T>(res);
  if (!res.ok) return { status: res.status, data: null, error: body?.error, needsAdmin: res.status === 403 };
  return { status: res.status, data: body as T };
}

export const getCatalog = () => getAdmin<AdminCatalog>("/api/admin/catalog");
export const getBans = () => getAdmin<{ data: BanEntry[] }>("/api/admin/read/bans").then((r) => ({ ...r, data: r.data?.data ?? null }));
export const getAdminPlayers = () => getAdmin<{ data: { players: (LivePlayer & { y: number })[] } }>("/api/admin/players").then((r) => ({ ...r, data: r.data?.data.players ?? null }));
export const readAdmin = (name: AdminRead) => getAdmin<{ data: unknown }>(`/api/admin/read/${name}`);

// ---- kits ------------------------------------------------------------------

export interface KitLine {
  item: string;
  amount: number;
  quality: number;
}

export interface Kit {
  name: string;
  lines: KitLine[];
}

/** Ready-made loadouts; device-local custom kits remain separate. */
export const PRESET_KITS: (Kit & { nameKey: TextKey })[] = [
  {
    name: "Starter",
    nameKey: "admin.items.kit.starter",
    lines: [
      { item: "Wood", amount: 50, quality: 1 },
      { item: "Stone", amount: 30, quality: 1 },
      { item: "Resin", amount: 20, quality: 1 },
      { item: "Club", amount: 1, quality: 1 },
      { item: "ShieldWood", amount: 1, quality: 1 },
      { item: "Torch", amount: 1, quality: 1 },
      { item: "CookedMeat", amount: 10, quality: 1 },
    ],
  },
  {
    name: "Bronze age",
    nameKey: "admin.items.kit.bronze",
    lines: [
      { item: "Bronze", amount: 20, quality: 1 },
      { item: "BronzeNails", amount: 100, quality: 1 },
      { item: "FineWood", amount: 40, quality: 1 },
      { item: "AxeBronze", amount: 1, quality: 2 },
      { item: "PickaxeBronze", amount: 1, quality: 2 },
      { item: "HelmetBronze", amount: 1, quality: 2 },
    ],
  },
  {
    name: "Boss prep",
    nameKey: "admin.items.kit.boss",
    lines: [
      { item: "MeadHealthMedium", amount: 10, quality: 1 },
      { item: "MeadStaminaMedium", amount: 10, quality: 1 },
      { item: "MeadPoisonResist", amount: 5, quality: 1 },
      { item: "ArrowFire", amount: 100, quality: 1 },
      { item: "BowFineWood", amount: 1, quality: 3 },
    ],
  },
  {
    name: "Iron age",
    nameKey: "admin.items.kit.iron",
    lines: [
      { item: "Iron", amount: 20, quality: 1 },
      { item: "IronNails", amount: 100, quality: 1 },
      { item: "ElderBark", amount: 30, quality: 1 },
      { item: "PickaxeIron", amount: 1, quality: 2 },
      { item: "AxeIron", amount: 1, quality: 2 },
      { item: "ShieldBanded", amount: 1, quality: 2 },
      { item: "Sausages", amount: 5, quality: 1 },
      { item: "TurnipStew", amount: 5, quality: 1 },
      { item: "CarrotSoup", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Mountains",
    nameKey: "admin.items.kit.mountains",
    lines: [
      { item: "Silver", amount: 20, quality: 1 },
      { item: "WolfPelt", amount: 10, quality: 1 },
      { item: "Obsidian", amount: 30, quality: 1 },
      { item: "PickaxeIron", amount: 1, quality: 2 },
      { item: "CapeWolf", amount: 1, quality: 2 },
      { item: "MeadFrostResist", amount: 5, quality: 1 },
      { item: "WolfJerky", amount: 5, quality: 1 },
      { item: "OnionSoup", amount: 5, quality: 1 },
      { item: "CookedWolfMeat", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Plains",
    nameKey: "admin.items.kit.plains",
    lines: [
      { item: "BlackMetal", amount: 20, quality: 1 },
      { item: "LinenThread", amount: 30, quality: 1 },
      { item: "Barley", amount: 20, quality: 1 },
      { item: "AxeBlackMetal", amount: 1, quality: 2 },
      { item: "ShieldBlackmetal", amount: 1, quality: 2 },
      { item: "LoxPie", amount: 5, quality: 1 },
      { item: "FishWraps", amount: 5, quality: 1 },
      { item: "Bread", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Mistlands",
    nameKey: "admin.items.kit.mistlands",
    lines: [
      { item: "BlackMarble", amount: 30, quality: 1 },
      { item: "Copper", amount: 20, quality: 1 },
      { item: "Iron", amount: 20, quality: 1 },
      { item: "PickaxeBlackMetal", amount: 1, quality: 2 },
      { item: "Demister", amount: 1, quality: 1 },
      { item: "MeadHealthMajor", amount: 5, quality: 1 },
      { item: "MisthareSupreme", amount: 5, quality: 1 },
      { item: "MeatPlatter", amount: 5, quality: 1 },
      { item: "Salad", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Ashlands",
    nameKey: "admin.items.kit.ashlands",
    lines: [
      { item: "FlametalNew", amount: 20, quality: 1 },
      { item: "Grausten", amount: 50, quality: 1 },
      { item: "Blackwood", amount: 30, quality: 1 },
      { item: "PickaxeBlackMetal", amount: 1, quality: 2 },
      { item: "ShieldFlametal", amount: 1, quality: 2 },
      { item: "BarleyWine", amount: 5, quality: 1 },
      { item: "MashedMeat", amount: 5, quality: 1 },
      { item: "PiquantPie", amount: 5, quality: 1 },
      { item: "ScorchingMedley", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Deep North",
    nameKey: "admin.items.kit.deepnorth",
    lines: [
      { item: "Gold", amount: 20, quality: 1 },
      { item: "MooseHide", amount: 10, quality: 1 },
      { item: "MooseSinew", amount: 10, quality: 1 },
      { item: "PickaxeBlackMetal", amount: 1, quality: 2 },
      { item: "CapeDeepNorth", amount: 1, quality: 2 },
      { item: "MeadFrostResist", amount: 5, quality: 1 },
      { item: "MooseKebab", amount: 5, quality: 1 },
      { item: "SealSoup", amount: 5, quality: 1 },
      { item: "Pancakes", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Prep: Eikthyr",
    nameKey: "admin.items.kit.eikthyr",
    lines: [
      { item: "SpearFlint", amount: 1, quality: 2 },
      { item: "ShieldWood", amount: 1, quality: 2 },
      { item: "ArmorLeatherChest", amount: 1, quality: 2 },
      { item: "ArmorLeatherLegs", amount: 1, quality: 2 },
      { item: "HelmetLeather", amount: 1, quality: 2 },
      { item: "CookedMeat", amount: 5, quality: 1 },
      { item: "CookedDeerMeat", amount: 5, quality: 1 },
      { item: "Honey", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Prep: The Elder",
    nameKey: "admin.items.kit.elder",
    lines: [
      { item: "BowFineWood", amount: 1, quality: 2 },
      { item: "AxeBronze", amount: 1, quality: 2 },
      { item: "ShieldBronzeBuckler", amount: 1, quality: 2 },
      { item: "ArmorBronzeChest", amount: 1, quality: 2 },
      { item: "ArmorBronzeLegs", amount: 1, quality: 2 },
      { item: "HelmetBronze", amount: 1, quality: 2 },
      { item: "ArrowFire", amount: 100, quality: 1 },
      { item: "MeadHealthMinor", amount: 5, quality: 1 },
      { item: "MeadStaminaMinor", amount: 5, quality: 1 },
      { item: "DeerStew", amount: 5, quality: 1 },
      { item: "MinceMeatSauce", amount: 5, quality: 1 },
      { item: "CarrotSoup", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Prep: Bonemass",
    nameKey: "admin.items.kit.bonemass",
    lines: [
      { item: "MaceIron", amount: 1, quality: 2 },
      { item: "ShieldBanded", amount: 1, quality: 2 },
      { item: "ArmorIronChest", amount: 1, quality: 2 },
      { item: "ArmorIronLegs", amount: 1, quality: 2 },
      { item: "HelmetIron", amount: 1, quality: 2 },
      { item: "MeadPoisonResist", amount: 5, quality: 1 },
      { item: "MeadHealthMedium", amount: 5, quality: 1 },
      { item: "MeadStaminaMinor", amount: 5, quality: 1 },
      { item: "Sausages", amount: 5, quality: 1 },
      { item: "SerpentStew", amount: 5, quality: 1 },
      { item: "TurnipStew", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Prep: Moder",
    nameKey: "admin.items.kit.moder",
    lines: [
      { item: "BowDraugrFang", amount: 1, quality: 2 },
      { item: "SwordSilver", amount: 1, quality: 2 },
      { item: "ShieldSilver", amount: 1, quality: 2 },
      { item: "ArmorWolfChest", amount: 1, quality: 2 },
      { item: "ArmorWolfLegs", amount: 1, quality: 2 },
      { item: "HelmetDrake", amount: 1, quality: 2 },
      { item: "CapeWolf", amount: 1, quality: 2 },
      { item: "ArrowObsidian", amount: 100, quality: 1 },
      { item: "ArrowPoison", amount: 100, quality: 1 },
      { item: "MeadFrostResist", amount: 5, quality: 1 },
      { item: "MeadHealthMedium", amount: 5, quality: 1 },
      { item: "MeadStaminaMinor", amount: 5, quality: 1 },
      { item: "WolfMeatSkewer", amount: 5, quality: 1 },
      { item: "SerpentStew", amount: 5, quality: 1 },
      { item: "OnionSoup", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Prep: Yagluth",
    nameKey: "admin.items.kit.yagluth",
    lines: [
      { item: "MaceSilver", amount: 1, quality: 2 },
      { item: "ShieldBlackmetal", amount: 1, quality: 2 },
      { item: "ArmorPaddedCuirass", amount: 1, quality: 2 },
      { item: "ArmorPaddedGreaves", amount: 1, quality: 2 },
      { item: "HelmetPadded", amount: 1, quality: 2 },
      { item: "BarleyWine", amount: 5, quality: 1 },
      { item: "MeadHealthMedium", amount: 5, quality: 1 },
      { item: "MeadStaminaMedium", amount: 5, quality: 1 },
      { item: "LoxPie", amount: 5, quality: 1 },
      { item: "FishWraps", amount: 5, quality: 1 },
      { item: "Bread", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Prep: The Queen",
    nameKey: "admin.items.kit.queen",
    lines: [
      { item: "SwordMistwalker", amount: 1, quality: 2 },
      { item: "ShieldCarapace", amount: 1, quality: 2 },
      { item: "ArmorCarapaceChest", amount: 1, quality: 2 },
      { item: "ArmorCarapaceLegs", amount: 1, quality: 2 },
      { item: "HelmetCarapace", amount: 1, quality: 2 },
      { item: "CapeFeather", amount: 1, quality: 2 },
      { item: "Demister", amount: 1, quality: 1 },
      { item: "MeadPoisonResist", amount: 5, quality: 1 },
      { item: "MeadHealthMajor", amount: 5, quality: 1 },
      { item: "MeadStaminaLingering", amount: 5, quality: 1 },
      { item: "MisthareSupreme", amount: 5, quality: 1 },
      { item: "MeatPlatter", amount: 5, quality: 1 },
      { item: "Salad", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Prep: Fader",
    nameKey: "admin.items.kit.fader",
    lines: [
      { item: "SwordNiedhogg", amount: 1, quality: 2 },
      { item: "ShieldFlametal", amount: 1, quality: 2 },
      { item: "ArmorFlametalChest", amount: 1, quality: 2 },
      { item: "ArmorFlametalLegs", amount: 1, quality: 2 },
      { item: "HelmetFlametal", amount: 1, quality: 2 },
      { item: "CapeAsksvin", amount: 1, quality: 2 },
      { item: "BarleyWine", amount: 5, quality: 1 },
      { item: "MeadHealthMajor", amount: 5, quality: 1 },
      { item: "MeadHealthLingering", amount: 5, quality: 1 },
      { item: "MeadStaminaLingering", amount: 5, quality: 1 },
      { item: "MashedMeat", amount: 5, quality: 1 },
      { item: "PiquantPie", amount: 5, quality: 1 },
      { item: "ScorchingMedley", amount: 5, quality: 1 },
    ],
  },
  {
    name: "Prep: Kall Fimbulbringer",
    nameKey: "admin.items.kit.kall",
    lines: [
      { item: "MaceGold", amount: 1, quality: 2 },
      { item: "ShieldGold", amount: 1, quality: 2 },
      { item: "ArmorDeepNorthHeavyChest", amount: 1, quality: 2 },
      { item: "ArmorDeepNorthHeavylegs", amount: 1, quality: 2 },
      { item: "HelmetDNHeavy", amount: 1, quality: 2 },
      { item: "CapeDeepNorth", amount: 1, quality: 2 },
      { item: "BarleyWine", amount: 5, quality: 1 },
      { item: "MeadFrostResist", amount: 5, quality: 1 },
      { item: "MeadHealthMajor", amount: 5, quality: 1 },
      { item: "MeadHealthLingering", amount: 5, quality: 1 },
      { item: "MeadStaminaLingering", amount: 5, quality: 1 },
      { item: "MooseKebab", amount: 5, quality: 1 },
      { item: "SealSoup", amount: 5, quality: 1 },
      { item: "Pancakes", amount: 5, quality: 1 },
    ],
  },

];

function validKit(k: unknown): k is Kit {
  const x = k as Partial<Kit> | null;
  return (
    !!x &&
    typeof x.name === "string" &&
    Array.isArray(x.lines) &&
    x.lines.every((l) => l && typeof l.item === "string" && Number.isFinite(l.amount) && Number.isFinite(l.quality))
  );
}

export function loadKits(): Kit[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KITS_KEY) ?? "null") as unknown;
    if (Array.isArray(raw)) return raw.filter(validKit).slice(0, 24);
  } catch {
    // storage blocked or garbage
  }
  return [];
}

export function saveKits(kits: Kit[]): void {
  try {
    localStorage.setItem(KITS_KEY, JSON.stringify(kits.slice(0, 24)));
  } catch {
    // not remembered; fine
  }
}

/** Stacks a line drops as, roughly: the plugin's cap is 60 stacks per call. */
export function stacksOf(lines: readonly KitLine[], stackSize: (item: string) => number): number {
  return lines.reduce((n, l) => n + Math.ceil(l.amount / Math.max(1, stackSize(l.item))), 0);
}

/** A rough stack size by kind: materials 50 (wood, stone, ...), ammo 100, food 10-20, gear 1. */
export function stackSize(item: string): number {
  if (/^(Arrow|Bolt|Missile)/.test(item) || /Nails$/.test(item)) return 100;
  if (/^(Mead|Cooked|Bread|Pie|Soup|Stew|Sausage|Fish|Honey|Raspberry|Blueberries|Carrot|Turnip|Onion|Mushroom)/.test(item)) return 10;
  if (/^(Sword|Axe|Pickaxe|Battleaxe|Bow|Crossbow|Knife|Mace|Sledge|Atgeir|Spear|Shield|Helmet|Armor|Cape|Club|Torch|Hammer|Hoe|Cultivator|Staff|Lantern|Trinket|Belt|Wishbone)/.test(item)) return 1;
  return 50;
}

// ---- display helpers -----------------------------------------------------

/** In-game clock for a day fraction: 0.25 -> 06:00. */
export function gameClock(fraction: number): string {
  const mins = Math.round((((fraction % 1) + 1) % 1) * 24 * 60) % (24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/** Creatures the spawn picker offers, by prefab; `boss` gets a confirmation. */
export const CREATURES: { prefab: string; boss?: boolean }[] = [
  { prefab: "Boar" },
  { prefab: "Deer" },
  { prefab: "Neck" },
  { prefab: "Greyling" },
  { prefab: "Greydwarf" },
  { prefab: "Troll" },
  { prefab: "Skeleton" },
  { prefab: "Draugr" },
  { prefab: "Wolf" },
  { prefab: "Lox" },
  { prefab: "Hen" },
  { prefab: "Asksvin" },
  { prefab: "Eikthyr", boss: true },
  { prefab: "gd_king", boss: true },
  { prefab: "Bonemass", boss: true },
  { prefab: "Dragon", boss: true },
  { prefab: "GoblinKing", boss: true },
  { prefab: "SeekerQueen", boss: true },
  { prefab: "Fader", boss: true },
];

/** World keys the panel explains; others can still be removed from the list. */
export const WORLD_KEYS: { key: string; boss?: boolean; risky?: boolean }[] = [
  { key: "defeated_eikthyr", boss: true },
  { key: "defeated_gdking", boss: true },
  { key: "defeated_bonemass", boss: true },
  { key: "defeated_dragon", boss: true },
  { key: "defeated_goblinking", boss: true },
  { key: "defeated_queen", boss: true },
  { key: "defeated_fader", boss: true },
  { key: "killedtroll" },
  { key: "killed_surtling" },
  { key: "killed_bat" },
  { key: "nobuildcost", risky: true },
  { key: "nocraftcost", risky: true },
  { key: "noworkbench", risky: true },
  { key: "allpiecesunlocked", risky: true },
  { key: "teleportall" },
  { key: "nomap" },
  { key: "noportals" },
  { key: "passivemobs" },
];

export const BROADCAST_MAX = 300;
