import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccessEntry, AccessListName, AccessState, AgentEvent, RestoreBackup, RestoreInfo, RestoreStep } from "../../types";
import { accessPath, getAccess, getRestoreInfo, PLATFORM_ID } from "../../lib/admin";
import { failText } from "../../lib/refusal";
import { useI18n, type TextKey } from "../../i18n";
import { PlatformGlyph } from "../PlatformGlyph";
import { Sheet } from "../Sheet";
import { useAdmin } from "./AdminContext";
import { BAN_HOLD_MS, HoldButton } from "./HoldButton";
import { AdminHead, Btn, Section } from "./parts";

const APPLIES: Record<string, TextKey> = {
  now: "admin.access.applies.now",
  restart: "admin.access.applies.restart",
  start: "admin.access.applies.start",
};

/**
 * The game's admin and ban lists. The agent edits the files (or, for bans
 * while the game runs, goes through the bridge); ids are shown here because
 * this sheet is for admins only.
 */
export function AccessLists() {
  const i18n = useI18n();
  const { t } = i18n;
  const admin = useAdmin()!;
  const [state, setState] = useState<AccessState | null>(null);
  const [failed, setFailed] = useState(false);
  const canRead = admin.unlocked;
  const reload = useCallback(() => {
    getAccess()
      .then((r) => {
        setState(r.data);
        setFailed(!r.data);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (canRead) reload();
  }, [canRead, reload]);

  const change = async (list: AccessListName, op: "add" | "remove", body: Record<string, unknown>) => {
    const r = await admin.post(accessPath(list, op), body, { quiet: true });
    if (r.ok) {
      const applies = (r.data as { applies?: string } | undefined)?.applies ?? "restart";
      admin.toast(true, t(APPLIES[applies] ?? "admin.access.applies.restart"));
    } else if (!r.needsAdmin) admin.toast(false, failText(i18n, r));
    reload();
    return r.ok;
  };

  return (
    <Section title={t("admin.access.title")}>
      <p className="mb-2 text-sm text-ash">{t("admin.access.lead")}</p>
      {!state ? (
        <p className="text-sm text-ash">{canRead ? (failed ? t("admin.access.failed") : t("admin.access.loading")) : t("admin.access.locked")}</p>
      ) : (
        <>
          {!state.writable && (
            <p role="status" className="mb-3 rounded-[3px] border border-ember/50 bg-black/35 px-3 py-2 text-sm text-flame">
              {t("admin.access.readonly")}
            </p>
          )}
          {state.online.length > 0 && (
            <div className="mb-3">
              <p className="label-caps mb-1.5">{t("admin.access.online")}</p>
              <ul className="divide-y divide-iron/25">
                {state.online.map((p) => (
                  <li key={p.name} className="flex min-h-12 flex-wrap items-center gap-2 py-1.5">
                    <PlatformGlyph platform={p.platform} className="text-label" />
                    <span className="min-w-24 flex-1 truncate font-bold text-bone">{p.name}</span>
                    {p.admin && <span className="text-xs text-flame">{t("admin.access.isAdmin")}</span>}
                    {p.banned && <span className="text-xs text-blood">{t("admin.access.isBanned")}</span>}
                    {!p.canAdd ? (
                      <span className="text-xs text-ash">{t("admin.access.noId")}</span>
                    ) : (
                      <>
                        {!p.admin && (
                          <Btn disabled={!state.writable} onClick={() => void change("admins", "add", { player: p.name })}>
                            {t("admin.access.makeAdmin")}
                          </Btn>
                        )}
                        {!p.banned && (
                          <HoldButton ms={BAN_HOLD_MS} disabled={!state.writable && !state.bans.live} label={t("admin.access.banAria", { name: p.name })} onConfirm={() => void change("bans", "add", { player: p.name })}>
                            {t("admin.access.ban")}
                          </HoldButton>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-ash">{t("admin.access.oneTapNote")}</p>
            </div>
          )}
          <EntryList list="admins" entries={state.admins.entries} disabled={!state.writable} onRemove={(id) => void change("admins", "remove", { id })} />
          <EntryList list="bans" entries={state.bans.entries} disabled={!state.writable && !state.bans.live} onRemove={(id) => void change("bans", "remove", { id })} />
          <AddById writable={state.writable} bansLive={state.bans.live} onAdd={(list, id) => change(list, "add", { id })} />
          <p className="mt-2 text-xs text-ash">{state.bans.live ? t("admin.access.liveBans") : t("admin.access.fileBans")}</p>
          <p className="mt-1 text-xs text-ash">{t("admin.access.fileNote")}</p>
        </>
      )}
    </Section>
  );
}

function EntryList({ list, entries, disabled, onRemove }: { list: AccessListName; entries: AccessEntry[]; disabled: boolean; onRemove: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="mb-3">
      <p className="label-caps mb-1.5">
        {t(list === "admins" ? "admin.access.admins" : "admin.access.bans")} <span className="text-ash">{entries.length}</span>
      </p>
      {entries.length === 0 ? (
        <p className="text-sm text-ash">{t(list === "admins" ? "admin.access.noAdmins" : "admin.access.noBans")}</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center gap-3">
              <PlatformGlyph platform={e.platform} className="text-label" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-bone">{e.name ?? t("admin.access.unnamed", { platform: t(`platform.${e.platform}`) })}</p>
                <p className="truncate font-mono text-[0.6875rem] text-ash">
                  {e.id}
                  {!e.known && <span className="ml-2 font-sans text-ember">{t("admin.access.oddFormat")}</span>}
                </p>
              </div>
              <HoldButton danger={false} disabled={disabled} label={t("admin.access.removeAria", { who: e.name ?? e.id })} onConfirm={() => onRemove(e.id)}>
                {t(list === "admins" ? "admin.access.remove" : "admin.access.unban")}
              </HoldButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An id typed by hand, checked as the agent will check it. */
function AddById({ writable, bansLive, onAdd }: { writable: boolean; bansLive: boolean; onAdd: (list: AccessListName, id: string) => Promise<boolean> }) {
  const { t } = useI18n();
  const [id, setId] = useState("");
  const value = id.trim();
  const valid = PLATFORM_ID.test(value);
  const bad = value !== "" && !valid;
  const add = async (list: AccessListName) => {
    if (await onAdd(list, value)) setId("");
  };
  return (
    <div>
      <label htmlFor="access-id" className="text-xs text-ash">
        {t("admin.access.addLabel")}
      </label>
      <input
        id="access-id"
        value={id}
        onChange={(e) => setId(e.target.value)}
        maxLength={64}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={t("admin.access.placeholder")}
        aria-invalid={bad}
        aria-describedby={bad ? "access-id-bad" : undefined}
        className={`field mt-1.5 w-full font-mono ${bad ? "field-bad" : ""}`}
      />
      {bad && (
        <p id="access-id-bad" role="alert" className="mt-1.5 text-xs text-blood">
          {t("admin.access.badId")}
        </p>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Btn disabled={!valid || !writable} onClick={() => void add("admins")}>
          {t("admin.access.addAdmin")}
        </Btn>
        <HoldButton ms={BAN_HOLD_MS} disabled={!valid || (!writable && !bansLive)} onConfirm={() => void add("bans")}>
          {t("admin.access.addBan")}
        </HoldButton>
      </div>
    </div>
  );
}

// ---- restore -------------------------------------------------------------------

const REASON: Record<NonNullable<RestoreInfo["reason"]>, TextKey> = {
  readonly: "admin.restore.readonly",
  noworld: "admin.restore.noworld",
};

/** The backups a restore can use, newest first, each opening the restore sheet. */
export function RestoreSection() {
  const { t, fullDate, date, clock, bytes } = useI18n();
  const admin = useAdmin()!;
  const [info, setInfo] = useState<RestoreInfo | null>(null);
  const canRead = admin.unlocked;
  // Fresh on open, and whenever the restore's own events arrive.
  const lastRestore = admin.events.find((e) => e.type === "admin" && e.data.command === "restore")?.seq ?? 0;
  useEffect(() => {
    if (!canRead) return;
    getRestoreInfo()
      .then((r) => setInfo(r.data))
      .catch(() => undefined);
  }, [canRead, lastRestore]);

  const blocked = info?.reason ? t(REASON[info.reason]) : info?.running ? t("admin.restore.running") : null;
  return (
    <Section title={t("admin.restore.title")} aside={info ? String(info.backups.length) : undefined}>
      <p className="mb-2 text-sm text-ash">{t("admin.restore.lead")}</p>
      {!info ? (
        <p className="text-sm text-ash">{canRead ? t("admin.access.loading") : t("admin.restore.locked")}</p>
      ) : (
        <>
          {blocked && (
            <p role="status" className="mb-3 rounded-[3px] border border-ember/50 bg-black/35 px-3 py-2 text-sm text-flame">
              {blocked}
            </p>
          )}
          {info.backups.length === 0 ? (
            <p className="text-sm text-ash">{t("admin.restore.none")}</p>
          ) : (
            <ul className="scroll-quiet max-h-75 space-y-1 overflow-y-auto pr-1">
              {info.backups.map((b) => (
                <li key={`${b.source}/${b.name}`} className="flex items-center gap-3 rounded-[3px] px-1.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    {/* Date and time wrap as whole pieces, never clipped: backups of one day differ only by the time. */}
                    <time dateTime={b.modifiedAt} title={fullDate(b.modifiedAt)} className="block text-sm font-bold text-bone">
                      <span className="inline-block">{date(b.modifiedAt)}</span> <span className="inline-block">{clock(b.modifiedAt)}</span>
                    </time>
                    <p className="truncate text-[0.6875rem] text-ash">
                      {bytes(b.sizeBytes)}
                      {b.source === "skald" && <span className="ml-2 text-flame">{t("admin.restore.skald")}</span>}
                    </p>
                  </div>
                  <Btn disabled={!!blocked} onClick={() => admin.open({ kind: "restore", backup: b })} title={t("admin.restore.openAria", { date: fullDate(b.modifiedAt) })}>
                    {t("admin.restore.open")}
                  </Btn>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

const STEPS: RestoreStep[] = ["begin", "safety", "stop", "extract", "start", "done"];

/** Where a run stands, from its `admin` events (oldest first). */
export function restoreProgress(events: AgentEvent[], sinceSeq: number) {
  const mine = events
    .filter((e) => e.type === "admin" && e.data.command === "restore" && e.seq > sinceSeq)
    .sort((a, b) => a.seq - b.seq);
  // A run starts at its own "begin"; earlier runs are not this one.
  const begin = mine.findIndex((e) => e.data.step === "begin");
  const run = begin < 0 ? [] : mine.slice(begin);
  const ok = new Set<string>();
  let error: string | null = null;
  for (const e of run) {
    if (e.data.result === "ok") ok.add(String(e.data.step));
    else if (error === null) error = String(e.data.error ?? "");
  }
  const at = run.findIndex((e) => e.data.step === "rollback");
  const rollback = at < 0 ? undefined : run[at];
  const rolledBack = rollback?.data.result === "ok";
  const done = ok.has("done");
  // How a run ends: done; a failure before the stop (nothing changed); or a
  // rollback that failed, or one followed by the game's start.
  const failedEarly = run.some((e) => e.data.result === "error" && ["begin", "safety", "stop"].includes(String(e.data.step)));
  const finished = done || failedEarly || (!!rollback && (!rolledBack || run.slice(at + 1).some((e) => e.data.step === "start")));
  return { started: run.length > 0, ok, error, rolledBack, done, finished };
}

/** The dangerous one: typed world name, a long hold, then the steps as they happen. */
export function RestoreSheet({ backup, onClose }: { backup: RestoreBackup; onClose: () => void }) {
  const { t, fullDate, bytes } = useI18n();
  const admin = useAdmin()!;
  const [typed, setTyped] = useState("");
  const [sent, setSent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const world = admin.world;
  const playersOnline = admin.players.length > 0;
  const ready = !!world && typed === world && !playersOnline && !busy;
  const date = fullDate(backup.modifiedAt);
  const progress = useMemo(() => (sent === null ? null : restoreProgress(admin.events, sent)), [admin.events, sent]);

  const go = async () => {
    setBusy(true);
    // Everything after the newest event so far belongs to this run.
    const since = admin.events.reduce((m, e) => Math.max(m, e.seq), 0);
    const r = await admin.post("/api/admin/restore", { source: backup.source, backup: backup.name, confirm: typed }, { done: t("admin.restore.started") });
    setBusy(false);
    if (r.ok) setSent(since);
  };

  return (
    <Sheet
      labelledBy="restore-h"
      onClose={onClose}
      width="sm:w-lg"
      header={(close) => (
        <AdminHead
          id="restore-h"
          kicker={t("admin.kicker")}
          title={t("admin.restore.sheetTitle")}
          sub={t("admin.restore.from", { date, size: bytes(backup.sizeBytes) })}
          emblem={
            <svg width="30" height="30" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-blood" aria-hidden>
              <path d="M4 10a6 6 0 1 0 2-4.5M4 3v3h3M10 7v3l2 2" />
            </svg>
          }
          onClose={close}
        />
      )}
    >
      <div className="pb-4">
        {progress === null ? (
          <>
            <div className="rounded-[3px] border border-blood/50 bg-[linear-gradient(180deg,rgba(120,30,24,0.28),rgba(70,16,12,0.38))] px-4 py-3">
              <p className="font-bold text-bone">{t("admin.restore.warn", { date })}</p>
              <p className="mt-1.5 text-sm text-bone/85">{t("admin.restore.steps")}</p>
            </div>
            <p className="mt-3 text-sm text-ash">{t("admin.restore.undo")}</p>
            {playersOnline && (
              <p role="status" className="mt-3 text-sm font-bold text-flame">
                {t("admin.restore.players")}
              </p>
            )}
            <label htmlFor="restore-confirm" className="mt-4 block text-sm text-bone">
              {t("admin.restore.confirmLabel", { world })}
            </label>
            <input
              id="restore-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              className="field mt-1.5 w-full font-mono"
            />
            <HoldButton className="mt-3 w-full" ms={2000} disabled={!ready} onConfirm={() => void go()}>
              {t("admin.restore.go", { date })}
            </HoldButton>
          </>
        ) : (
          <RestoreSteps progress={progress} onClose={onClose} />
        )}
      </div>
    </Sheet>
  );
}

function RestoreSteps({ progress, onClose }: { progress: ReturnType<typeof restoreProgress>; onClose: () => void }) {
  const { t } = useI18n();
  const shown = progress.rolledBack ? [...STEPS.filter((s) => s !== "done"), "rollback" as const] : STEPS;
  return (
    <div aria-live="polite">
      <ol className="space-y-2">
        {shown.map((s) => {
          const ok = progress.ok.has(s);
          return (
            <li key={s} className="flex items-center gap-3 text-sm">
              <span aria-hidden className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${ok ? "border-flame/60 bg-ember/30 text-flame" : "border-iron/60 text-ash"}`}>
                {ok ? "✓" : ""}
              </span>
              <span className={ok ? "text-bone" : "text-ash"}>{t(`admin.restore.step.${s}`)}</span>
            </li>
          );
        })}
      </ol>
      {progress.error !== null && (
        <p role="alert" className="mt-3 text-sm text-blood">
          {t(progress.rolledBack ? "admin.restore.rolledBack" : "admin.restore.failed", { error: progress.error })}
        </p>
      )}
      {progress.done && (
        <p role="status" className="mt-3 font-bold text-flame">
          {t("admin.restore.doneText")}
        </p>
      )}
      {!progress.finished && <p className="mt-3 text-xs text-ash">{t("admin.restore.wait")}</p>}
      {progress.finished && (
        <Btn className="mt-4 w-full" onClick={onClose}>
          {t("admin.close")}
        </Btn>
      )}
    </div>
  );
}
