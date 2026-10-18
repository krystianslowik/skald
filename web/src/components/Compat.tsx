import { useState } from "react";
import type { CompatCheck, CompatResult, CompatStatus, CompatView } from "../types";
import { useI18n, type I18n, type TextKey } from "../i18n";
import { RelativeTime } from "./RelativeTime";
import { useAdmin, viewOnly } from "./admin/AdminContext";

/** Valheim reports its build as "l-1.0.20"; people know it as 1.0.20. */
export const shortBuild = (b: string | undefined) => (b ?? "").replace(/^[a-z]-/, "");

const STATUS_CLASS: Record<CompatStatus, string> = {
  ok: "text-select-hi",
  warn: "text-gold",
  fail: "text-blood",
  pending: "text-ash",
  skipped: "text-ash/60",
};

/** One check's mark: a tick, a warning sign, a cross, a clock or a dash. */
export function StatusMark({ status, size = 18 }: { status: CompatStatus; size?: number }) {
  const { t } = useI18n();
  const common = { width: size, height: size, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <span role="img" aria-label={t(`compat.status.${status}` as TextKey)} className={`inline-grid shrink-0 place-items-center ${STATUS_CLASS[status]}`}>
      {status === "ok" && (
        <svg {...common} aria-hidden>
          <path d="M4.5 10.5l3.5 3.5 7.5-8" />
        </svg>
      )}
      {status === "warn" && (
        <svg {...common} aria-hidden>
          <path d="M10 3l7.5 13.5h-15z" />
          <path d="M10 8.5v3.5M10 14.5v.01" />
        </svg>
      )}
      {status === "fail" && (
        <svg {...common} aria-hidden>
          <path d="M5 5l10 10M15 5L5 15" />
        </svg>
      )}
      {status === "pending" && (
        <svg {...common} aria-hidden>
          <circle cx="10" cy="10" r="7" />
          <path d="M10 6v4l2.5 2" />
        </svg>
      )}
      {status === "skipped" && (
        <svg {...common} aria-hidden>
          <path d="M5.5 10h9" />
        </svg>
      )}
    </span>
  );
}

/** What one check found, as a sentence; the reason code when no text knows it. */
export function checkText(i: I18n, c: CompatCheck): string {
  const d = c.detail ?? {};
  const num = (k: string) => i.number(Number(d[k] ?? 0) || 0);
  const vars = {
    build: shortBuild(String(d.build ?? d.gameBuild ?? "")),
    previous: shortBuild(String(d.previousBuild ?? "")),
    plugin: String(d.plugin ?? "?"),
    bridge: shortBuild(String(d.gameBuild ?? "")),
    n: c.name === "save" && c.reason === "chunks_unreadable" ? num("chunksUnreadable") : num("containersUnreadable"),
    why: String(d.containerReason ?? ""),
    gen: num("generation"),
    chunks: num("chunks"),
    s: num("worldLoadedSeconds"),
  };
  const reason = c.reason || (c.name === "logs" && d.joinCode === true ? "ok_join" : "ok");
  let text = i.lookup(`compat.${c.name}.${reason}`, vars) ?? i.t("compat.unknownReason", { reason });
  if (c.name === "version" && d.networkChanged === true) text += ` ${i.t("compat.version.network", { from: String(d.previousNetworkVersion ?? "?"), to: String(d.networkVersion ?? "?") })}`;
  return text;
}

/** The build line: what it was updated from, or just the build. */
export function buildLine(i: I18n, r: CompatResult): string {
  if (!r.build) return i.t("compat.noBuild");
  return r.updated && r.previousBuild ? i.t("compat.updated", { from: shortBuild(r.previousBuild), to: shortBuild(r.build) }) : i.t("compat.build", { build: shortBuild(r.build) });
}

/**
 * The compatibility check in the admin sheet: one row per part with its mark
 * and what it found, when it ran, and the button to run it again (admins).
 */
export function CompatRows({ view }: { view: CompatView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const r = view.result;
  if (!r) return <p className="text-sm text-ash">{view.running ? t("compat.running") : t("compat.none")}</p>;
  return (
    <div>
      <p className="text-sm text-bone">{buildLine(i18n, r)}</p>
      <p className="mt-0.5 text-xs text-ash">
        {view.running ? (
          t("compat.running")
        ) : (
          <RelativeTime iso={r.checkedAt} format={(ago) => t("compat.checkedAt", { ago, trigger: t(`compat.trigger.${r.trigger}` as TextKey) })} />
        )}
      </p>
      <ul className="mt-3 divide-y divide-iron/25" aria-label={t("compat.title")}>
        {r.checks.map((c) => (
          <li key={c.name} className="flex items-start gap-3 py-2.5">
            <span className="mt-0.5">
              <StatusMark status={c.status} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-bone">{t(`compat.check.${c.name}` as TextKey)}</p>
              <p className={`mt-0.5 wrap-break-word text-xs ${c.status === "fail" ? "text-blood" : c.status === "warn" ? "text-gold" : "text-ash"}`}>{checkText(i18n, c)}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const DISMISS_KEY = "skald.compat.dismissed";

function dismissedAt(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * The notice everyone with the panel sees when the last check warns or
 * fails: what changed, which parts, and a way to the details. A view-only
 * session gets one plain line instead: the parts and the details are the
 * admin's. Dismissed per device until the next check.
 */
export function CompatNotice({ view, onDetails, className = "" }: { view: CompatView | null | undefined; onDetails?: () => void; className?: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [dismissed, setDismissed] = useState(dismissedAt);
  const viewer = viewOnly(useAdmin());
  const r = view?.result;
  if (!r || (r.status !== "warn" && r.status !== "fail") || dismissed === r.checkedAt) return null;
  const to = shortBuild(r.build);
  const fail = r.status === "fail";
  const parts = viewer ? [] : r.checks.filter((c) => c.status === r.status).map((c) => t(`compat.check.${c.name}` as TextKey));
  const head = viewer
    ? t(r.updated ? (fail ? "compat.notice.viewerFail" : "compat.notice.viewerWarn") : fail ? "compat.notice.viewerFailBuild" : "compat.notice.viewerWarnBuild", { to })
    : r.updated
      ? t(r.status === "fail" ? "compat.notice.fail" : "compat.notice.warn", { to })
      : t(r.status === "fail" ? "compat.notice.failBuild" : "compat.notice.warnBuild", { to });
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, r.checkedAt);
    } catch {
      // private mode: hidden for this visit only
    }
    setDismissed(r.checkedAt);
  };
  return (
    <div role="status" className={`plank flex flex-wrap items-center gap-3 border px-4 py-3 text-sm ${r.status === "fail" ? "border-blood/50" : "border-gold/40"} ${className}`}>
      <StatusMark status={r.status} size={22} />
      <div className="min-w-0 flex-1">
        <p className="font-bold text-bone">{head}</p>
        {!viewer && <p className="mt-0.5 text-xs text-ash">{t("compat.notice.parts", { parts: new Intl.ListFormat(i18n.intl, { type: "conjunction" }).format(parts) })}</p>}
      </div>
      <div className="flex basis-full justify-end gap-2 sm:basis-auto">
        {onDetails && !viewer && (
          <button type="button" onClick={onDetails} className="plaque press min-h-11 px-4 text-sm font-bold">
            {t("compat.notice.details")}
          </button>
        )}
        <button type="button" onClick={dismiss} className="press min-h-11 px-3 text-sm font-bold text-ash hover:text-bone">
          {t("compat.notice.dismiss")}
        </button>
      </div>
    </div>
  );
}
