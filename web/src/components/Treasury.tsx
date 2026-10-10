import { memo } from "react";
import type { Backup } from "../types";
import { backupHref } from "../lib/api";
import { useI18n } from "../i18n";

/** Treasury: world backups, newest first, each downloadable. */
export const Treasury = memo(function Treasury({ backups, now }: { backups: Backup[]; now: number }) {
  const { t, ago, bytes, fullDate } = useI18n();
  if (backups.length === 0) return <p className="text-sm text-ash">{t("treasury.empty")}</p>;
  return (
    <ul className="scroll-quiet max-h-[18.75rem] space-y-1 overflow-y-auto pr-1">
      {backups.map((b, i) => (
        <li
          key={b.name}
          className="flex items-center gap-3 rounded-[3px] px-1.5 py-1.5 transition-colors hover:bg-black/20"
        >
          {/* The newest backup is the "equipped" one: its slot fills blue. */}
          <span className={`grid h-10 w-10 shrink-0 place-items-center ${i === 0 ? "slot-selected" : "slot"}`}>
            <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden>
              <path d="M3 8.5c0-2.5 3-4 7-4s7 1.5 7 4V16H3z" fill="none" stroke={i === 0 ? "#10161d" : "#d79c34"} strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M3 9.5h14M9 9.5v2.5h2V9.5" fill="none" stroke={i === 0 ? "#10161d" : "#d79c34"} strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-bone" title={b.name}>
              {fullDate(b.modifiedAt)}
            </div>
            <div className="truncate text-[0.6875rem] text-ash">{b.name}</div>
          </div>
          <div className="text-right text-xs tabular-nums">
            <div className="font-bold text-bone">{bytes(b.sizeBytes)}</div>
            <div className="text-ash">{ago(b.modifiedAt, now)}</div>
          </div>
          <a
            href={backupHref(b.name)}
            download={b.name}
            aria-label={t("treasury.downloadAria", { name: b.name })}
            title={t("treasury.download")}
            className="plaque press grid h-9 w-9 shrink-0 place-items-center coarse:h-11 coarse:w-11"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" />
            </svg>
          </a>
        </li>
      ))}
    </ul>
  );
});
