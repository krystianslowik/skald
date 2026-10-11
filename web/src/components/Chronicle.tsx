import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { LogStore } from "../lib/useValheim";
import { stripAnsi, stripValheimStamp } from "../lib/format";
import { useI18n } from "../i18n";

const NOTABLE = /join code|ZDOID|World saved|PlayFab|version|error|exception|warn/i;
const BAD = /error|exception|failed|INTERNET_CONNECTIVITY|ServiceUnavailable/i;
const SHOWN_MAX = 600;

/**
 * Chronicle: the live server log with a text filter. Sticks to the bottom until you scroll up.
 * It subscribes to the log store itself, so a new line re-renders only this plank.
 */
export const Chronicle = memo(function Chronicle({ source }: { source: LogStore }) {
  const { t, clockSec } = useI18n();
  const lines = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const [q, setQ] = useState("");
  const [onlyNotable, setOnlyNotable] = useState(false);
  // Typing stays instant; the (up to 1500-line) filter catches up when the main thread is free.
  const needle = useDeferredValue(q.trim().toLowerCase());
  const notable = useDeferredValue(onlyNotable);
  const stale = needle !== q.trim().toLowerCase() || notable !== onlyNotable;
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const shown = useMemo(() => {
    const out: { key: string; ts: string; text: string; tone: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (stripAnsi(l.line).trim() === "") continue;
      if (notable && !NOTABLE.test(l.line)) continue;
      if (needle && !l.line.toLowerCase().includes(needle)) continue;
      const text = stripValheimStamp(l.line);
      out.push({ key: `${l.ts}-${i}`, ts: l.ts, text, tone: BAD.test(text) ? "text-blood" : NOTABLE.test(text) ? "text-flame" : "text-bone/75" });
    }
    return out.length > SHOWN_MAX ? out.slice(-SHOWN_MAX) : out;
  }, [lines, needle, notable]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="relative min-w-48 flex-1">
          <span className="sr-only">{t("chronicle.filter")}</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("chronicle.search")}
            className="slot w-full border border-transparent px-3 py-1.5 text-sm coarse:min-h-11 text-bone placeholder:text-ash/80 focus:border-select-hi focus:outline-hidden"
          />
        </label>
        <label className="press flex cursor-pointer items-center gap-2 text-xs text-ash coarse:min-h-11">
          <input type="checkbox" checked={onlyNotable} onChange={(e) => setOnlyNotable(e.target.checked)} className="accent-[#5e97cc]" />
          {t("chronicle.notable")}
        </label>
        <span className="text-xs tabular-nums text-ash">
          {t("chronicle.count", { shown: shown.length, total: lines.length })}
        </span>
      </div>
      <div
        ref={box}
        className={`scroll-quiet h-80 overflow-y-auto rounded-[3px] bg-[#120c08] p-3 font-mono text-xs leading-[1.55] shadow-[inset_0_2px_12px_rgba(0,0,0,0.75),inset_0_0_0_1px_rgba(0,0,0,0.5)] transition-opacity ${stale ? "opacity-70" : ""}`}
        role="log"
        aria-live="off"
      >
        {shown.length === 0 && <p className="text-ash">{lines.length === 0 ? t("chronicle.empty") : t("chronicle.noMatch")}</p>}
        {shown.map((l) => (
          <div key={l.key} className="log-row flex gap-3 whitespace-pre-wrap break-all">
            <span className="shrink-0 select-none text-ash">{clockSec(l.ts)}</span>
            <span className={l.tone}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
