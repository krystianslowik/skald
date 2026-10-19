import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, Suspense, useCallback, useMemo, useState } from "react";
import { shortfall, stillMissing, stockTotals, type MaterialNeed } from "@server/taskmodel";
import { useI18n } from "../../i18n";
import { itemLabel } from "../../lib/storage";
import { nextStatus, sortTasks, updateTask, useTasks, type Task } from "../../lib/tasks";
import { useStorage, type StorageLoad } from "../../lib/useStorage";
import { ItemIcon } from "../storage/ItemIcon";
import { StatusMark, targetLabel } from "./marks";
import { lazyChunk } from "../../lib/chunks";
import { ChunkBoundary } from "../ErrorBoundary";

// The editor (with the item search) loads when a task is first opened.
const TaskSheet = lazyChunk(() => import("./TaskSheet"), "TaskSheet");

/** The stores' totals per item, or null while they are unknown (loading, map off, failed). */
export function useStock(saveKey: string): { stock: ReadonlyMap<string, number> | null; load: StorageLoad } {
  const [load] = useStorage(saveKey);
  const containers = load.status === "ready" ? load.storage.containers : null;
  const stock = useMemo(() => (containers ? stockTotals(containers) : null), [containers]);
  return { stock, load };
}

/** Lines of the shopping list shown on a card before "and N more". */
const SHOWN_MISSING = 4;

const STATUS_NEXT_LABEL = { todo: "tasks.start", doing: "tasks.finish", done: "tasks.reopen" } as const;

/** What is still missing, in a line: "4 Coal, 1 Stone and 2 more". */
function MissingLine({ needs }: { needs: MaterialNeed[] }) {
  const { t, lookup, number } = useI18n();
  const shown = needs.slice(0, SHOWN_MISSING);
  return (
    <ul className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1" aria-label={t("tasks.missing")}>
      {shown.map((n) => (
        <li key={n.item} className="flex items-center gap-1 text-xs text-bone">
          <ItemIcon name={n.item} size={13} iconSize={18} className="text-flame" />
          <span className="font-bold tabular-nums text-flame">{number(n.missing)}</span>
          <span>{itemLabel(n.item, lookup)}</span>
        </li>
      ))}
      {needs.length > shown.length && <li className="text-xs text-ash">{t("tasks.missingMore", { n: needs.length - shown.length })}</li>}
    </ul>
  );
}

const TaskCard = memo(function TaskCard({ task, stock, onOpen, onUnauthorized }: { task: Task; stock: ReadonlyMap<string, number> | null; onOpen: (t: Task) => void; onUnauthorized?: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const needs = useMemo(() => (stock ? stillMissing(shortfall(task.materials, stock)) : null), [task.materials, stock]);
  const where = targetLabel(i18n, task);
  const done = task.status === "done";
  const advance = async () => {
    if (busy) return;
    navigator.vibrate?.(6);
    setBusy(true);
    const r = await updateTask(task.id, { status: nextStatus(task.status) }, { status: task.status });
    setBusy(false);
    if (!r.ok && r.error === "unauthorized") onUnauthorized?.();
    setFailed(r.ok || r.error === "unauthorized" ? null : r.error === "stale" ? t("tasks.error.staleCard") : r.error === "rate_limited" ? t("tasks.error.rateLimited", { n: r.retryAfter }) : t("tasks.saveFailed"));
  };
  const meta = [task.owner, where].filter(Boolean).join(" · ");
  return (
    <div className={`flex items-start gap-2 rounded-[3px] border border-iron/30 bg-black/20 p-1.5 ${done ? "opacity-75" : ""}`}>
      <button
        type="button"
        onClick={() => void advance()}
        disabled={busy}
        aria-label={t(STATUS_NEXT_LABEL[task.status], { title: task.title })}
        title={t(STATUS_NEXT_LABEL[task.status], { title: task.title })}
        className="slot press grid h-11 w-11 shrink-0 place-items-center disabled:opacity-50"
      >
        <StatusMark status={task.status} size={20} />
      </button>
      <button type="button" onClick={() => onOpen(task)} aria-haspopup="dialog" className="press-soft min-w-0 flex-1 rounded-[2px] px-1 py-1 text-left hover:bg-black/25">
        <span className={`block text-sm font-bold leading-snug text-bone ${done ? "line-through decoration-ash/70" : ""}`}>{task.title}</span>
        <span className="mt-0.5 block text-xs text-ash">
          <span className={task.status === "doing" ? "text-flame" : undefined}>{t(`tasks.status.${task.status}`)}</span>
          {meta && <> · {meta}</>}
        </span>
        {!done && task.materials.length > 0 && (needs === null ? null : needs.length > 0 ? <MissingLine needs={needs} /> : <span className="mt-1.5 block text-xs font-bold text-select-hi">{t("tasks.allInStores")}</span>)}
        {failed && (
          <span role="alert" className="mt-1 block text-xs text-blood">
            {failed}
          </span>
        )}
      </button>
    </div>
  );
});

/**
 * The group's shared tasks: what is being done and by whom, each with its
 * material list held against the village stores, so a card shows only what
 * still has to be gathered. Changes from any open page arrive over /live.
 */
export function TaskBoard({ saveKey, players, onUnauthorized }: { saveKey: string; players: readonly string[]; onUnauthorized?: () => void }) {
  const { t, number } = useI18n();
  const reduced = useReducedMotion();
  const tasks = useTasks(onUnauthorized);
  const { stock, load } = useStock(saveKey);
  // null: closed; "new": a blank sheet; a task: that task as it was when opened.
  const [open, setOpen] = useState<Task | "new" | null>(null);
  const [showDone, setShowDone] = useState(false);
  const { open: openTasks, done } = useMemo(() => sortTasks(tasks ?? []), [tasks]);
  const onOpen = useCallback((task: Task) => setOpen(task), []);
  const close = useCallback(() => setOpen(null), []);
  const editing = open !== null && open !== "new" ? open : null;
  const gone = editing !== null && !!tasks && !tasks.some((x) => x.id === editing.id);
  const spring = { type: "spring", bounce: 0, visualDuration: 0.3 } as const;
  const stockNote = load.status === "off" ? t("tasks.storesOff") : load.status === "failed" ? t("tasks.storesFailed") : null;

  const list = (items: Task[]) => (
    <ol className="space-y-2">
      <AnimatePresence initial={false}>
        {items.map((task) => (
          <motion.li key={task.id} layout={reduced ? false : "position"} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={spring}>
            <TaskCard task={task} stock={stock} onOpen={onOpen} onUnauthorized={onUnauthorized} />
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );

  return (
    <div className="text-sm">
      <button type="button" onClick={() => setOpen("new")} aria-haspopup="dialog" className="plaque press flex min-h-11 w-full items-center justify-center gap-2 py-2 font-bold text-flame! hover:text-gold!">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M8 3v10M3 8h10" />
        </svg>
        {t("tasks.new")}
      </button>
      <div className="mt-3">
        {tasks === null ? (
          <p className="py-2 text-center text-flame">{t("tasks.loading")}</p>
        ) : openTasks.length === 0 ? (
          <p className="py-2 text-center text-ash">{done.length > 0 ? t("tasks.allDone") : t("tasks.empty")}</p>
        ) : (
          list(openTasks)
        )}
      </div>
      {stockNote && openTasks.some((x) => x.materials.length > 0) && <p className="mt-2 text-xs text-ash">{stockNote}</p>}
      {done.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone} className="press-soft flex w-full items-center gap-2 rounded-[2px] px-1 py-2 text-left text-xs font-bold text-ash hover:bg-black/25 coarse:min-h-11">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden className={`shrink-0 transition-transform ${showDone ? "rotate-180" : ""}`}>
              <path d="M2.5 4.5L6 8l3.5-3.5" />
            </svg>
            {t("tasks.doneList", { n: number(done.length) })}
          </button>
          {showDone && <div className="mt-1">{list(done)}</div>}
        </div>
      )}
      {open !== null && (
        <ChunkBoundary overlay onClose={close}>
          <Suspense fallback={null}>
            <TaskSheet key={editing?.id ?? "new"} task={editing} gone={gone} stock={stock} players={players} onClose={close} onUnauthorized={onUnauthorized} />
          </Suspense>
        </ChunkBoundary>
      )}
    </div>
  );
}
