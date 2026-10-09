import { useEffect, useMemo, useRef, useState } from "react";
import type { LogLine } from "../types";
import { stripAnsi, stripValheimStamp } from "../lib/format";
import { useI18n } from "../i18n";

const NOTABLE = /join code|ZDOID|World saved|PlayFab|version|error|exception|warn/i;
const BAD = /error|exception|failed|INTERNET_CONNECTIVITY|ServiceUnavailable/i;

/** Chronicle: the live server log with a text filter. Sticks to the bottom until you scroll up. */
export function Chronicle({ lines }: { lines: LogLine[] }) {
  const { t, clockSec } = useI18n();
  const [q, setQ] = useState("");
  const [onlyNotable, setOnlyNotable] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lines
      .filter((l) => stripAnsi(l.line).trim() !== "")
      .filter((l) => (!onlyNotable || NOTABLE.test(l.line)) && (!needle || l.line.toLowerCase().includes(needle)))
      .slice(-600);
  }, [lines, q, onlyNotable]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">{t("chronicle.filter")}</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("chronicle.search")}
            className="w-full rounded-md border border-iron/40 bg-black/30 px-3 py-1.5 text-sm text-bone placeholder:text-ash/60 focus:border-ember/60 focus:outline-none"
          />
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-ash">
          <input type="checkbox" checked={onlyNotable} onChange={(e) => setOnlyNotable(e.target.checked)} className="accent-[#ff7a1a]" />
          {t("chronicle.notable")}
        </label>
        <span className="text-xs tabular-nums text-ash/70">
          {t("chronicle.count", { shown: shown.length, total: lines.length })}
        </span>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="scroll-quiet h-[320px] overflow-y-auto rounded-md border border-black/40 bg-[#0b0806]/80 p-3 font-mono text-[12px] leading-[1.55] shadow-[inset_0_2px_12px_rgba(0,0,0,0.7)]"
        role="log"
        aria-live="off"
      >
        {shown.length === 0 && <p className="text-ash">{lines.length === 0 ? t("chronicle.empty") : t("chronicle.noMatch")}</p>}
        {shown.map((l, i) => {
          const text = stripValheimStamp(l.line);
          return (
            <div key={`${l.ts}-${i}`} className="flex gap-3 whitespace-pre-wrap break-all">
              <span className="shrink-0 select-none text-iron">{clockSec(l.ts)}</span>
              <span className={BAD.test(text) ? "text-[#e3a091]" : NOTABLE.test(text) ? "text-flame/90" : "text-bone/70"}>{text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
