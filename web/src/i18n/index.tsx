import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type Dict, type Plural } from "./en";
import { pl } from "./pl";

export type Locale = "en" | "pl";
export const LOCALES: readonly Locale[] = ["en", "pl"];
const DICTS: Record<Locale, Dict> = { en, pl };
/** Intl tag per UI language; en-GB for 24-hour clocks, like the game's own log. */
const INTL: Record<Locale, string> = { en: "en-GB", pl: "pl-PL" };
/** Each language names itself in the toggle. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", pl: "Polski" };

type KeysOf<V> = { [K in keyof Dict]: Dict[K] extends V ? K : never }[keyof Dict];
export type TextKey = KeysOf<string>;
export type PluralKey = Exclude<keyof Dict, TextKey>;
type Vars = Record<string, string | number>;

const PLACEHOLDER = /\{(\w+)\}/g;
const fill = (s: string, vars?: Vars) => (vars ? s.replace(PLACEHOLDER, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

export interface I18n {
  locale: Locale;
  /** BCP 47 tag for Intl. */
  intl: string;
  t(key: TextKey, vars?: Vars): string;
  /** Plural entry picked by `Intl.PluralRules`; `{n}` is the locale-formatted count. */
  tn(key: PluralKey, n: number, vars?: Vars): string;
  /** Lookup by a key built at runtime (raids, bosses, badges); undefined when unknown. */
  lookup(key: string, vars?: Vars): string | undefined;
  number(n: number, maxFractionDigits?: number): string;
  duration(ms: number): string;
  ago(iso: string | null | undefined, now?: number): string;
  bytes(n: number): string;
  rate(bytesPerSec: number): string;
  clock(t: string | number): string;
  clockSec(t: string | number): string;
  fullDate(t: string | number): string;
  /** Date without the time, to pair with `clock`. */
  date(t: string | number): string;
  /** "Today" / "Yesterday" / a long weekday date, in the viewer's own time zone. */
  dayLabel(iso: string, now?: number): string;
  /** `-crossplay -modifier raids less -preset hard` -> readable chips. */
  modifiers(args: string): string[];
  raidLabel(id: string): string;
}

export function makeI18n(locale: Locale): I18n {
  const dict = DICTS[locale];
  const intl = INTL[locale];
  const rules = new Intl.PluralRules(intl);
  const nf = new Map<number, Intl.NumberFormat>();
  const number = (n: number, max = 0) => {
    let f = nf.get(max);
    if (!f) nf.set(max, (f = new Intl.NumberFormat(intl, { maximumFractionDigits: max })));
    return f.format(n);
  };
  const t = (key: TextKey, vars?: Vars) => fill(dict[key], vars);
  const tn = (key: PluralKey, n: number, vars?: Vars) => {
    const p = dict[key] as Plural;
    const form = p[rules.select(n) as keyof Plural] ?? p.other;
    return fill(form, { n: number(n, 2), ...vars });
  };
  const lookup = (key: string, vars?: Vars) => {
    const v = (dict as Record<string, unknown>)[key];
    return typeof v === "string" ? fill(v, vars) : undefined;
  };
  const bytesFmt = new Intl.NumberFormat(intl, { maximumFractionDigits: 1 });
  const bytes = (n: number) => {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = n;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
      v /= 1000;
      i++;
    }
    return `${bytesFmt.format(v)} ${units[i]}`;
  };

  return {
    locale,
    intl,
    t,
    tn,
    lookup,
    number,
    duration(ms) {
      const min = Math.max(0, Math.floor(ms / 60_000));
      if (min < 1) return t("time.lessThanMinute");
      const d = Math.floor(min / 1440);
      const h = Math.floor((min % 1440) / 60);
      const m = min % 60;
      if (d > 0) return `${tn("time.days", d)} ${h} h`;
      if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
      return `${m} min`;
    },
    ago(iso, now = Date.now()) {
      if (!iso) return t("time.never");
      const diff = now - Date.parse(iso);
      if (!Number.isFinite(diff)) return t("time.never");
      if (diff < 45_000) return t("time.justNow");
      const min = Math.round(diff / 60_000);
      if (min < 60) return t("time.minAgo", { n: min });
      const h = Math.round(min / 60);
      if (h < 24) return t("time.hAgo", { n: h });
      const d = Math.round(h / 24);
      if (d === 1) return t("time.yesterday");
      return tn("time.daysAgo", d);
    },
    bytes,
    rate: (b) => `${bytes(b)}/s`,
    clock: (v) => new Date(v).toLocaleTimeString(intl, { hour: "2-digit", minute: "2-digit" }),
    clockSec: (v) => new Date(v).toLocaleTimeString(intl, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    fullDate: (v) => new Date(v).toLocaleString(intl, { dateStyle: "medium", timeStyle: "short" }),
    date: (v) => new Date(v).toLocaleDateString(intl, { dateStyle: "medium" }),
    dayLabel(iso, now = Date.now()) {
      const d = new Date(iso);
      const today = new Date(now);
      const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
      if (diff === 0) return t("day.today");
      if (diff === 1) return t("day.yesterday");
      return d.toLocaleDateString(intl, { weekday: "long", day: "numeric", month: "long" });
    },
    modifiers(args) {
      const out: string[] = [];
      const a = args.split(/\s+/).filter(Boolean);
      for (let i = 0; i < a.length; i++) {
        const w = a[i]!;
        if (w === "-crossplay") out.push("crossplay");
        else if (w === "-modifier" && a[i + 2]) {
          const k = a[i + 1]!.toLowerCase();
          const v = a[i + 2]!.toLowerCase();
          out.push(`${lookup(`mod.${k}`) ?? k}: ${lookup(`modv.${v}`) ?? v}`);
          i += 2;
        } else if (w === "-preset" && a[i + 1]) {
          out.push(`preset: ${a[i + 1]}`);
          i += 1;
        } else if (w === "-setkey" && a[i + 1]) {
          out.push(a[i + 1]!);
          i += 1;
        }
      }
      return out;
    },
    raidLabel(id) {
      const known = lookup(`raid.${id}`);
      if (known) return known;
      if (id.startsWith("hildirboss")) return t("raid.hildirboss");
      return id;
    },
  };
}

const STORAGE_KEY = "skald_locale";

/** The viewer's own choice, if they made one; storage can be blocked. */
export function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

function storeLocale(l: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // private mode or blocked storage: the toggle still works for this visit
  }
}

type Ctx = I18n & { setLocale(l: Locale): void };

const I18nContext = createContext<Ctx>({ ...makeI18n("en"), setLocale: () => undefined });

export const useI18n = (): Ctx => useContext(I18nContext);

/**
 * Holds the active language. `locale` is the starting point (the viewer's
 * stored choice, else the server default); `setLocale` from the header toggle
 * wins from then on and is remembered per browser.
 */
export function I18nProvider({ locale: initial, children }: { locale: Locale; children: ReactNode }) {
  const [locale, setState] = useState<Locale>(initial);
  useEffect(() => setState(initial), [initial]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    storeLocale(l);
    setState(l);
  }, []);
  const value = useMemo(() => ({ ...makeI18n(locale), setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Two-letter EN / PL switch. */
export function LocaleToggle({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div role="group" aria-label={t("lang.label")} className={`inline-flex gap-0.5 text-[0.6875rem] font-bold ${className}`}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={locale === l}
          aria-label={fill(DICTS[l]["lang.switchTo"], { lang: LOCALE_NAMES[l] })}
          onClick={() => setLocale(l)}
          className="plaque press px-2 py-1 uppercase tracking-wider coarse:min-h-11 coarse:min-w-11 coarse:text-sm"
        >
          {l}
        </button>
      ))}
    </div>
  );
}
