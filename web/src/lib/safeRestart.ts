import type { I18n } from "../i18n";
import type { SafeRestartRun, SafeRestartStep } from "../types";

/** The deadlines and countdowns the panel offers, in minutes; 0 is none. */
export const SAFE_DEADLINES = [0, 30, 60, 120, 240] as const;
export const SAFE_WARNINGS = [0, 1, 5, 10] as const;

/** The admin's name as the panel shows it: a device without a name is "someone". */
export function actorName(i: Pick<I18n, "t">, raw: unknown): string {
  const s = String(raw ?? "");
  return !s || s === "unknown" || s.startsWith("dashboard-") ? i.t("saga.admin.someone") : s;
}

/** Minutes as "30 min" or "2 h". */
export function minutesLabel(i: Pick<I18n, "t">, n: number): string {
  return n >= 60 && n % 60 === 0 ? i.t("admin.safe.hour", { n: n / 60 }) : i.t("admin.safe.min", { n });
}

/** Time left as "4:07", or "1:02:03" past an hour. */
export function left(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Why a step was skipped or only partly done, in words; undefined for a code this panel does not know. */
export function stepReason(i: Pick<I18n, "lookup">, s: Pick<SafeRestartStep, "name" | "reason">): string | undefined {
  return s.reason ? i.lookup(`admin.safe.reason.${s.name}.${s.reason}`) : undefined;
}

/** The run can still be called off: it waits or counts down. */
export const cancellable = (run: SafeRestartRun | null | undefined): boolean => run?.state === "running" && (run.step === "wait" || run.step === "countdown" || run.step === "");

/**
 * A `restart_run` event as a saga line, or null for the steps that only
 * matter while watching (the run is about 18 events; the saga keeps the
 * story: who started it, the countdown, the checked backup, the end).
 */
export function describeSafeRestart(i: Pick<I18n, "t" | "lookup" | "bytes">, d: Record<string, unknown>): { text: string; failed: boolean } | null {
  const run = d.run && typeof d.run === "object" ? (d.run as SafeRestartRun) : null;
  if (!run) return null;
  const step = String(d.step ?? "");
  const result = String(d.result ?? "");
  const actor = actorName(i, run.actor);
  switch (`${step}:${result}`) {
    case "begin:running":
      return { text: i.t(run.request.whenEmpty ? "saga.safe.beginEmpty" : "saga.safe.begin", { actor }), failed: false };
    case "wait:ok":
      return run.forced ? null : { text: i.t("saga.safe.empty"), failed: false };
    case "countdown:running":
      return { text: i.t(run.forced ? "saga.safe.countdownForced" : "saga.safe.countdown", { n: run.request.warnMinutes }), failed: false };
    case "verify:ok":
      return { text: i.t("saga.safe.verified", { archive: run.archive ?? "", size: i.bytes(run.archiveBytes ?? 0) }), failed: false };
    case "save:warn":
      return { text: i.t("saga.safe.saveWarn"), failed: false };
    case "end:done":
      return { text: run.joinCode ? i.t("saga.safe.done", { code: run.joinCode }) : i.t("saga.safe.doneNoCode"), failed: false };
    case "end:failed":
      return { text: i.t("saga.safe.failed"), failed: true };
    case "end:cancelled":
      return { text: i.t("saga.safe.cancelled", { actor: actorName(i, run.cancelledBy) }), failed: false };
  }
  if (result === "error") {
    const s = run.steps.find((x) => x.name === step);
    const error = (s && stepReason(i, s)) ?? s?.error ?? "";
    return { text: i.t("saga.safe.stepFailed", { step: i.lookup(`admin.safe.step.${step}`) ?? step, error }), failed: true };
  }
  return null;
}
