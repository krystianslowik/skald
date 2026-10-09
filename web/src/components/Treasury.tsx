import type { Backup } from "../types";
import { backupHref } from "../lib/api";
import { useI18n } from "../i18n";

/** Treasury: world backups, newest first, each downloadable. */
export function Treasury({ backups, now }: { backups: Backup[]; now: number }) {
  const { t, ago, bytes, fullDate } = useI18n();
  if (backups.length === 0) return <p className="text-sm text-ash">{t("treasury.empty")}</p>;
  return (
    <ul className="scroll-quiet max-h-[300px] space-y-1 overflow-y-auto pr-1">
      {backups.map((b, i) => (
        <li
          key={b.name}
          className={`flex items-center gap-3 rounded-md px-3 py-2 ${i === 0 ? "bg-ember/[0.08] ring-1 ring-ember/25" : "hover:bg-black/15"}`}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden className="shrink-0">
            <rect x="2.5" y="6" width="15" height="10.5" rx="1.5" fill="none" stroke={i === 0 ? "#ffb347" : "#5b5650"} strokeWidth="1.4" />
            <path d="M2.5 9.5h15M8 6V4h4v2" fill="none" stroke={i === 0 ? "#ffb347" : "#5b5650"} strokeWidth="1.4" />
          </svg>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-bone" title={b.name}>
              {fullDate(b.modifiedAt)}
            </div>
            <div className="truncate text-[11px] text-ash">{b.name}</div>
          </div>
          <div className="text-right text-xs tabular-nums">
            <div className="text-bone/90">{bytes(b.sizeBytes)}</div>
            <div className="text-ash">{ago(b.modifiedAt, now)}</div>
          </div>
          <a
            href={backupHref(b.name)}
            download={b.name}
            aria-label={t("treasury.downloadAria", { name: b.name })}
            title={t("treasury.download")}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-iron/40 text-ash transition-colors hover:border-ember/60 hover:bg-ember/10 hover:text-flame"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" />
            </svg>
          </a>
        </li>
      ))}
    </ul>
  );
}
