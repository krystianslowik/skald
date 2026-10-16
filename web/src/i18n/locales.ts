// The UI languages. Plain data with no imports, so vite.config.ts can use it
// too. A language also needs its dictionary file (`<locale>.ts`) and a loader
// in load.ts.

export type Locale = "en" | "pl";
export const LOCALES: readonly Locale[] = ["en", "pl"];

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/** Where the viewer's own language choice is kept. */
export const LOCALE_STORAGE_KEY = "skald_locale";
