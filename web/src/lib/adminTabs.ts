// The admin sheet's tabs and the parts inside them, as URL slugs. A link
// `#admin/<tab>` or `#admin/<section>` opens the sheet there (a notice, a push
// notification); while the sheet is open the address shows the tab it is on.
// Slugs are ASCII and the same in every language.

export type AdminTab = "players" | "world" | "base" | "server";
export const ADMIN_TABS: readonly AdminTab[] = ["players", "world", "base", "server"];

/** Every part of the sheet a link can open at: its tab and the id of its heading. */
export const PANEL_SECTIONS = {
  online: { tab: "players", heading: "admin-players-h" },
  broadcast: { tab: "players", heading: "admin-broadcast-h" },
  access: { tab: "players", heading: "admin-access-h" },
  time: { tab: "world", heading: "admin-time-h" },
  raids: { tab: "world", heading: "admin-raids-h" },
  creatures: { tab: "world", heading: "admin-creatures-h" },
  keys: { tab: "world", heading: "admin-keys-h" },
  helpers: { tab: "base", heading: "admin-base-h" },
  items: { tab: "base", heading: "admin-items-h" },
  save: { tab: "world", heading: "admin-save-h" },
  restart: { tab: "server", heading: "admin-safe-h" },
  compat: { tab: "server", heading: "admin-compat-h" },
  discord: { tab: "server", heading: "admin-discord-h" },
  restore: { tab: "server", heading: "admin-restore-h" },
  you: { tab: "players", heading: "admin-you-h" },
} as const satisfies Record<string, { tab: AdminTab; heading: string }>;

/** A part of the admin sheet it can open at. */
export type PanelSection = keyof typeof PANEL_SECTIONS;

/** Where a link into the admin sheet points; empty for the sheet itself. */
export interface PanelLink {
  tab?: AdminTab;
  section?: PanelSection;
}

const isTab = (s: string): s is AdminTab => (ADMIN_TABS as readonly string[]).includes(s);
const isSection = (s: string): s is PanelSection => Object.hasOwn(PANEL_SECTIONS, s);

/** Whether a URL hash points into the admin sheet (`#admin`, `#admin/...`). */
export const isAdminHash = (hash: string): boolean => /^#?admin(\/|$)/i.test(hash);

/** The link a hash makes, or null when it is not one into the admin sheet. An unknown part opens the sheet as usual. */
export function parseAdminHash(hash: string): PanelLink | null {
  if (!isAdminHash(hash)) return null;
  const part = hash.replace(/^#?admin\/?/i, "").split(/[/?#]/)[0]!.toLowerCase();
  if (isTab(part)) return { tab: part };
  if (isSection(part)) return { section: part };
  return {};
}

/** The hash for a tab or a section. */
export const adminHash = (part: AdminTab | PanelSection): string => `#admin/${part}`;

/** The tab a section sits in. */
export const tabOf = (section: PanelSection): AdminTab => PANEL_SECTIONS[section].tab;

/** The page's own address under the open admin sheet, whose entry shows `#admin/...` instead. */
let underSheet: string | null = null;

/** Where the page was when the open admin sheet took its entry; null with no sheet open. */
export const pageUnderSheet = (): string | null => underSheet;

/** Set by the open admin sheet; `was` clears it only if it is still that sheet's. */
export function setPageUnderSheet(page: string | null, was?: string): void {
  if (page !== null || was === undefined || underSheet === was) underSheet = page;
}

const KEY = "skald.admin.tab";
/** The choice for this visit when storage refused it; wins over what is stored. */
let memory: AdminTab | null = null;

/** The tab this viewer had open last, or null. */
export function rememberedTab(): AdminTab | null {
  if (memory) return memory;
  try {
    const v = localStorage.getItem(KEY);
    return v && isTab(v) ? v : null;
  } catch {
    return null;
  }
}

export function rememberTab(tab: AdminTab): void {
  try {
    localStorage.setItem(KEY, tab);
    memory = null;
  } catch {
    // private mode or full: kept for this visit
    memory = tab;
  }
}

/** Forgets the visit's choice (tests). */
export function forgetTab(): void {
  memory = null;
}
