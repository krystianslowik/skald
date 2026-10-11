import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { JoinCode } from "./JoinCode";
import { ServerPassword, useServerPassword } from "./ServerPassword";

const INCLUDE_KEY = "skald.share.password";
const SHARE_PATH = "M12 3.5v11M8 7.5l4-4 4 4M5.5 11.5v7a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-7";
const COPY_PATH = "M8.5 8.5h10v11h-10zM5.5 15.5v-10a1 1 0 0 1 1-1h9";

function storedInclude(): boolean {
  try {
    return localStorage.getItem(INCLUDE_KEY) !== "0";
  } catch {
    return true;
  }
}

type Note = "copied" | "shared" | "failed" | null;

/**
 * Everything a friend needs to join: the burning code, the password when the
 * server has one, and Share, which hands "Join <server> in Valheim: code
 * 123456, password ..." to the phone's share sheet (or copies it where there
 * is none). The password goes along only while "Include password" is on; it
 * starts on, since the panel is private, and is fetched when Share is pressed.
 * On phones a compact bar with the code slides down once the code has
 * scrolled away.
 */
export const JoinPanel = memo(function JoinPanel({
  code,
  codeAt,
  status,
  now,
  serverName,
  hasPassword,
  stamp,
  sticky,
}: {
  code: string;
  codeAt: string | null;
  status: string;
  now: number;
  serverName: string;
  /** The agent manages settings and a password is set. */
  hasPassword: boolean;
  /** Changes when the saved settings may have, dropping a fetched password. */
  stamp: unknown;
  /** Show the compact bar when the code scrolls out of view (phones). */
  sticky: boolean;
}) {
  const { t } = useI18n();
  const pw = useServerPassword(stamp);
  const [include, setInclude] = useState(storedInclude);
  const [note, setNote] = useState<Note>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = /^\d{6}$/.test(code);
  const withPassword = hasPassword && include;
  const { load } = pw;

  useEffect(() => () => void (noteTimer.current && clearTimeout(noteTimer.current)), []);
  const flash = useCallback((n: Note) => {
    setNote(n);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 2200);
  }, []);

  const toggleInclude = useCallback(() => {
    const next = !include;
    try {
      localStorage.setItem(INCLUDE_KEY, next ? "1" : "0");
    } catch {
      // not remembered; fine
    }
    setInclude(next);
    // Turned on by hand: fetch it now, so the next Share needs no wait.
    if (next) void load();
  }, [include, load]);

  // Pressing Share starts the password request, so the share sheet can open
  // while the tap still counts as the person's own action.
  const warm = useCallback(() => {
    if (withPassword) void load();
  }, [withPassword, load]);

  const share = useCallback(async () => {
    if (!ready) return;
    const name = serverName || "Valheim";
    const password = withPassword ? await load() : null;
    const text = password ? t("share.textPassword", { server: name, code, password }) : t("share.text", { server: name, code });
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        // Dismissed by the person: nothing to say. Anything else: fall back to copying.
        if ((e as { name?: string }).name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      flash("shared");
    } catch {
      flash("failed");
    }
  }, [ready, serverName, withPassword, load, t, code, flash]);

  const copyCode = useCallback(async () => {
    if (!ready) return;
    try {
      await navigator.clipboard.writeText(code);
      flash("copied");
    } catch {
      flash("failed");
    }
  }, [ready, code, flash]);

  // The code's own box: when it has scrolled up out of view, the bar takes over.
  const codeBox = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = codeBox.current;
    if (!sticky || !el || typeof IntersectionObserver === "undefined") {
      setAway(false);
      return;
    }
    const io = new IntersectionObserver(([e]) => setAway(!!e && !e.isIntersecting && e.boundingClientRect.top < 0), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [sticky]);

  return (
    <>
      <div ref={codeBox}>
        <JoinCode code={code} codeAt={codeAt} status={status} now={now} />
      </div>
      {hasPassword && <ServerPassword pw={pw} />}
      {ready && (
        <div className="mt-2 flex flex-col items-center gap-2.5">
          <button
            type="button"
            onPointerDown={warm}
            onClick={() => void share()}
            aria-label={t("share.aria")}
            className="plaque press inline-flex min-h-11 items-center gap-2 px-6 text-base font-bold text-flame! enabled:hover:text-gold!"
          >
            <Glyph d={SHARE_PATH} size={20} />
            {t("share.button")}
          </button>
          {hasPassword && (
            <label className="on-world inline-flex min-h-11 cursor-pointer select-none items-center gap-2.5 text-sm text-label">
              <input type="checkbox" checked={include} onChange={toggleInclude} className="peer sr-only" />
              <span
                aria-hidden
                className="h-6 w-10 shrink-0 rounded-full bg-black/55 p-[3px] shadow-[inset_0_1px_3px_rgba(0,0,0,0.8)] transition-colors peer-checked:bg-select peer-focus-visible:outline-solid peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-select-hi"
              >
                <span className={`block h-4.5 w-4.5 rounded-full bg-bone shadow-[0_1px_2px_rgba(0,0,0,0.5)] transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none ${include ? "translate-x-4" : ""}`} />
              </span>
              {t("share.includePassword")}
            </label>
          )}
          <NoteLine note={note} />
        </div>
      )}
      <AnimatePresence>
        {sticky && away && ready && (
          <motion.div
            key="bar"
            role="region"
            aria-label={t("joinCode.title")}
            className="material fixed inset-x-0 top-0 z-30 border-b border-black/60 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
            initial={{ y: "-100%", opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: "-100%", opacity: 0 }}
            transition={{ type: "spring", bounce: 0, visualDuration: 0.35 }}
          >
            <div className="mx-auto flex h-14 max-w-lg items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.6875rem] font-bold uppercase tracking-[0.12em] text-flame">{t("joinCode.title")}</p>
                <p className="digit digit-lit text-2xl tracking-[0.08em]" aria-label={code.split("").join(" ")}>
                  {code}
                </p>
              </div>
              <button type="button" onClick={() => void copyCode()} aria-label={t("joinCode.copy")} className="plaque press grid h-11 w-11 place-items-center">
                <Glyph d={COPY_PATH} size={20} />
              </button>
              <button type="button" onPointerDown={warm} onClick={() => void share()} aria-label={t("share.aria")} className="plaque press grid h-11 w-11 place-items-center text-flame!">
                <Glyph d={SHARE_PATH} size={20} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
});

function Glyph({ d, size }: { d: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function NoteLine({ note }: { note: Note }) {
  const { t } = useI18n();
  return (
    <div className="on-world h-5 text-xs" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        {note && (
          <motion.span key={note} className={note === "failed" ? "text-blood" : "text-flame"} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>
            {note === "copied" ? t("joinCode.copied") : note === "shared" ? t("share.copied") : t("share.failed")}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
