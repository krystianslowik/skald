import { useEffect, useState } from "react";
import type { SafeRestartRun, SafeRestartStep, SafeRestartStepState } from "../../types";
import { actorName, cancellable, left, minutesLabel, SAFE_DEADLINES, SAFE_WARNINGS, stepReason } from "../../lib/safeRestart";
import { useI18n } from "../../i18n";
import { useAdmin } from "./AdminContext";
import { HoldButton } from "./HoldButton";
import { Btn, Chip, Section } from "./parts";

/** A hold this long starts a run: it ends with the server down for a minute. */
const START_HOLD_MS = 1500;

/** Now, once a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * The safe restart: options and a hold to start it; while it runs, its steps
 * as the agent reports them, with a cancel while it still waits or counts
 * down; after it, how it ended. Everything comes from the run in /state and
 * its live events, so a reload or a skald-web restart shows the same.
 */
export function SafeRestartSection() {
  const { t } = useI18n();
  const admin = useAdmin()!;
  const run = admin.safeRestart;
  const active = run?.state === "running";
  const [whenEmpty, setWhenEmpty] = useState(true);
  const [deadline, setDeadline] = useState(60);
  const [warn, setWarn] = useState(5);
  const [busy, setBusy] = useState(false);

  // Agents before the feature have no field at all.
  if (run === undefined) {
    return (
      <Section title={t("admin.safe.title")} id="admin-safe">
        <p className="text-sm text-ash">{t("admin.safe.old")}</p>
      </Section>
    );
  }

  const start = async () => {
    setBusy(true);
    await admin.post("/api/admin/safe-restart", { whenEmpty, deadlineMinutes: whenEmpty ? deadline : 0, warnMinutes: warn }, { done: t("admin.safe.started") });
    setBusy(false);
  };
  const cancel = async () => {
    setBusy(true);
    await admin.post("/api/admin/safe-restart", {}, { method: "DELETE", done: t("admin.safe.cancelled") });
    setBusy(false);
  };
  // Warnings in game and the save need a bridge that takes commands.
  const bridgeOk = admin.bridgeOn && !admin.blocker;

  return (
    <Section title={t("admin.safe.title")} id="admin-safe">
      <p className="mb-3 text-sm text-ash">{t("admin.safe.lead")}</p>
      {active ? (
        <RunView run={run} busy={busy} onCancel={() => void cancel()} />
      ) : (
        <>
          {run && <Ended run={run} />}
          <div className="space-y-3">
            <Chip on={whenEmpty} onClick={() => setWhenEmpty(!whenEmpty)}>
              {t("admin.safe.whenEmpty")}
            </Chip>
            {whenEmpty && (
              <div>
                <p id="safe-deadline" className="mb-1.5 text-xs text-ash">
                  {t("admin.safe.deadline")}
                </p>
                <div role="radiogroup" aria-labelledby="safe-deadline" className="flex flex-wrap gap-2">
                  {SAFE_DEADLINES.map((m) => (
                    <Chip key={m} on={deadline === m} onClick={() => setDeadline(m)}>
                      {m === 0 ? t("admin.safe.deadline.none") : minutesLabel({ t }, m)}
                    </Chip>
                  ))}
                </div>
                {deadline > 0 && <p className="mt-1.5 text-xs text-ash">{t("admin.safe.deadlineHint")}</p>}
              </div>
            )}
            <div>
              <p id="safe-warn" className="mb-1.5 text-xs text-ash">
                {t("admin.safe.warn")}
              </p>
              <div role="radiogroup" aria-labelledby="safe-warn" className="flex flex-wrap gap-2">
                {SAFE_WARNINGS.map((m) => (
                  <Chip key={m} on={warn === m} onClick={() => setWarn(m)}>
                    {m === 0 ? t("admin.safe.warn.none") : minutesLabel({ t }, m)}
                  </Chip>
                ))}
              </div>
            </div>
            {!bridgeOk && <p className="text-xs text-ash">{t("admin.safe.noBridge")}</p>}
            <HoldButton className="w-full" ms={START_HOLD_MS} disabled={busy || admin.blocker === "offline"} onConfirm={() => void start()}>
              {t("admin.safe.go")}
            </HoldButton>
          </div>
        </>
      )}
    </Section>
  );
}

/** A run in progress: what it waits for, then its steps. */
function RunView({ run, busy, onCancel }: { run: SafeRestartRun; busy: boolean; onCancel: () => void }) {
  const { t } = useI18n();
  const admin = useAdmin()!;
  const now = useNow(true);
  const online = admin.players.length;
  let status: string;
  if (run.step === "wait" || run.step === "") {
    status = online > 0 ? t("admin.safe.waiting", { n: online }) : t("admin.safe.waitingEmpty");
    if (run.deadline) status += ` ${t("admin.safe.deadlineIn", { time: left(Date.parse(run.deadline) - now) })}`;
  } else if (run.step === "countdown" && run.restartAt) {
    status = t("admin.safe.restartIn", { time: left(Date.parse(run.restartAt) - now) });
    if (run.forced) status += ` ${t("admin.safe.forced")}`;
  } else status = t("admin.safe.inProgress");
  return (
    <div>
      <p role="status" aria-live="polite" className="mb-3 rounded-[3px] border border-ember/50 bg-black/35 px-3 py-2 text-sm font-bold text-flame tabular-nums">
        {status}
      </p>
      <Steps steps={run.steps} />
      {cancellable(run) && (
        <Btn className="mt-3 w-full" disabled={busy} onClick={onCancel}>
          {t("admin.safe.cancel")}
        </Btn>
      )}
    </div>
  );
}

/** How the last run ended. */
function Ended({ run }: { run: SafeRestartRun }) {
  const i18n = useI18n();
  const { t, bytes, ago } = i18n;
  return (
    <div className="mb-4 rounded-[3px] border border-iron/50 bg-black/25 px-3 py-3">
      <p className="text-xs text-ash">{t("admin.safe.last", { when: ago(run.endedAt ?? run.startedAt) })}</p>
      {run.state === "done" && (
        <>
          <p role="status" className="mt-1 font-bold text-flame">
            {t("admin.safe.done")}
          </p>
          {run.warning && <p className="mt-1 text-sm font-bold text-flame">{t("admin.safe.killed")}</p>}
          {run.joinCode && (
            <p className="mt-2">
              <span className="block text-xs text-ash">{t("admin.safe.code")}</span>
              <span className="font-mono text-2xl font-bold tracking-[0.2em] text-bone">{run.joinCode}</span>
            </p>
          )}
        </>
      )}
      {run.state === "failed" && (
        <p role="alert" className="mt-1 text-sm font-bold text-blood">
          {t("admin.safe.failed", { error: run.error ?? "" })}
        </p>
      )}
      {run.state === "cancelled" && <p className="mt-1 text-sm text-bone">{t("admin.safe.cancelledBy", { who: actorName(i18n, run.cancelledBy) })}</p>}
      {run.archive && (
        <p className="mt-2 break-all text-xs text-ash">
          {run.archiveBytes ? t("admin.safe.archive", { name: run.archive, size: bytes(run.archiveBytes) }) : t("admin.safe.archiveKept", { name: run.archive })}
        </p>
      )}
      {run.state === "failed" && <Steps steps={run.steps} className="mt-3" />}
    </div>
  );
}

const TONE: Record<SafeRestartStepState, string> = {
  pending: "border-iron/60 text-ash",
  running: "border-select-hi/70 bg-select/30 text-bone",
  ok: "border-flame/60 bg-ember/30 text-flame",
  skipped: "border-iron/60 text-ash",
  warn: "border-ember/70 text-flame",
  error: "border-blood/70 bg-blood/20 text-blood",
  cancelled: "border-iron/60 text-ash",
};

/** A step's mark: done, skipped, partly, failed, now, or nothing yet. */
function Mark({ state }: { state: SafeRestartStepState }) {
  const path: Partial<Record<SafeRestartStepState, string>> = {
    ok: "M3.5 8.5l3 3 6-7",
    skipped: "M4 8h8",
    cancelled: "M4 8h8",
    warn: "M8 3.5v5.5M8 12v.5",
    error: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  };
  return (
    <span aria-hidden className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${TONE[state]}`}>
      {state === "running" ? (
        <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
      ) : path[state] ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d={path[state]} />
        </svg>
      ) : null}
    </span>
  );
}

function Steps({ steps, className = "" }: { steps: SafeRestartStep[]; className?: string }) {
  const i18n = useI18n();
  const { t, lookup } = i18n;
  return (
    <ol className={`space-y-2 ${className}`}>
      {steps.map((s) => {
        const detail = s.state === "error" ? (stepReason(i18n, s) ?? s.error) : stepReason(i18n, s);
        const label = lookup(`admin.safe.step.${s.name}`) ?? s.name;
        return (
          <li key={s.name} className="flex items-start gap-3 text-sm">
            <Mark state={s.state} />
            <span className="min-w-0 flex-1 pt-0.5">
              <span className={s.state === "pending" || s.state === "skipped" ? "text-ash" : "text-bone"}>{label}</span>
              <span className="sr-only">: {t(`admin.safe.state.${s.state}`)}</span>
              {detail && <span className={`block text-xs ${s.state === "error" ? "text-blood" : "text-ash"}`}>{detail}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
