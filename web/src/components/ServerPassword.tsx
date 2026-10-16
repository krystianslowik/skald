import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getServerPassword } from "../lib/api";
import { useAdmin } from "./admin/AdminContext";
import { useI18n } from "../i18n";

const MASK = "\u2022".repeat(8);

export interface PasswordAccess {
  value: string | null;
  shown: boolean;
  setShown(v: boolean): void;
  note: "copied" | "failed" | null;
  flash(n: "copied" | "failed"): void;
  /** The password, fetched on first use; null when it could not be read. */
  load(): Promise<string | null>;
}

/**
 * The server password, fetched only when someone asks (reveal, copy, share).
 * `stamp` changes whenever the saved settings may have changed, dropping the
 * cached value.
 */
export function useServerPassword(stamp: unknown): PasswordAccess {
  const [shown, setShown] = useState(false);
  const [value, setValue] = useState<string | null>(null);
  const [note, setNote] = useState<"copied" | "failed" | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One request at a time: a press and its click share it.
  const pending = useRef<Promise<string | null> | null>(null);
  const cached = useRef<string | null>(null);

  useEffect(() => {
    setValue(null);
    cached.current = null;
    pending.current = null;
    setShown(false);
  }, [stamp]);
  useEffect(() => () => void (noteTimer.current && clearTimeout(noteTimer.current)), []);

  const flash = useCallback((n: "copied" | "failed") => {
    setNote(n);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 1800);
  }, []);

  // With an admin password, only an admin may read it: the unlock prompt first, as for any admin action.
  const unlock = useAdmin()?.unlock;
  const load = useCallback(async (): Promise<string | null> => {
    if (cached.current !== null) return cached.current;
    pending.current ??= (async () => {
      let r = await getServerPassword();
      if (r.status === 403) {
        if (!unlock || !(await unlock())) return null;
        r = await getServerPassword();
      }
      if (r.status !== 200) throw new Error();
      cached.current = r.body.password;
      setValue(r.body.password);
      return r.body.password;
    })()
      .catch(() => {
        flash("failed");
        return null;
      })
      .finally(() => {
        pending.current = null;
      });
    return pending.current;
  }, [flash, unlock]);

  return useMemo(() => ({ value, shown, setShown, note, flash, load }), [value, shown, note, flash, load]);
}

/** The server password under the join code, so friends get both at once. Masked until someone asks. */
export const ServerPassword = memo(function ServerPassword({ pw }: { pw: PasswordAccess }) {
  const { t } = useI18n();
  const { value, shown, setShown, note, flash, load } = pw;

  const toggle = async () => {
    if (shown) return setShown(false);
    if ((await load()) !== null) setShown(true);
  };

  const copy = async () => {
    const p = await load();
    if (p === null) return;
    try {
      await navigator.clipboard?.writeText(p);
    } catch {
      // clipboard denied: reveal instead so it can be read off the screen
      setShown(true);
    }
    flash("copied");
  };

  return (
    <div className="mt-4 flex flex-col items-center">
      <p className="on-world text-xs font-bold uppercase tracking-[0.16em] text-flame">{t("serverPass.title")}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span
          className="slot flex h-10 min-w-38 items-center justify-center px-4 font-mono text-lg font-bold tracking-[0.12em] text-gold coarse:h-11"
          aria-label={shown && value !== null ? undefined : t("serverPass.hidden")}
        >
          {shown && value !== null ? value : <span aria-hidden className="tracking-[0.2em] text-gold/60">{MASK}</span>}
        </span>
        <button type="button" onClick={() => void toggle()} aria-pressed={shown} aria-label={shown ? t("serverPass.hide") : t("serverPass.show")} title={shown ? t("serverPass.hide") : t("serverPass.show")} className="plaque press grid h-10 w-10 place-items-center coarse:h-11 coarse:w-11">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" />
            {shown ? <circle cx="10" cy="10" r="2.4" /> : <path d="M4 16L16 4" />}
          </svg>
        </button>
        <button type="button" onClick={() => void copy()} aria-label={t("serverPass.copy")} title={t("serverPass.copy")} className="plaque press grid h-10 w-10 place-items-center coarse:h-11 coarse:w-11">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="6.5" y="6.5" width="9" height="10" rx="1" />
            <path d="M4 13.5V4.5a1 1 0 0 1 1-1h7" />
          </svg>
        </button>
      </div>
      <div className="on-world mt-1 h-5 text-xs" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          {note && (
            <motion.span key={note} className={note === "copied" ? "text-flame" : "text-blood"} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>
              {note === "copied" ? t("serverPass.copied") : t("serverPass.failed")}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
});
