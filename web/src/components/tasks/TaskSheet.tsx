import { useId, useMemo, useState, type ReactNode } from "react";
import { expandRecipe, RECIPE_KINDS, RECIPES, type Recipe } from "@server/recipes";
import { parseTaskInput, shortfall, TASK_LIMITS, TASK_STATUSES, type TaskInputError } from "@server/taskmodel";
import { useI18n } from "../../i18n";
import { BOSSES } from "../../lib/world";
import { itemLabel } from "../../lib/storage";
import { changedFields, createTask, deleteTask, updateTask, type Task, type TaskInput, type TaskMaterial, type TaskResult, type TaskTarget } from "../../lib/tasks";
import { ItemSearch } from "../admin/ItemPicker";
import { Btn, Chip, Stepper, useArmed } from "../admin/parts";
import { Sheet, SheetClose } from "../Sheet";
import { ItemIcon } from "../storage/ItemIcon";
import { StatusMark } from "./marks";

/** Player names offered as owners: the ranking's, most played first. */
const OWNER_CHIPS = 8;

type TargetKind = "none" | "boss" | "base";

function Field({ label, htmlFor, children, error }: { label: string; htmlFor?: string; children: ReactNode; error?: string | null }) {
  return (
    <div>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="label-caps mb-2 block">
          {label}
        </label>
      ) : (
        <p className="label-caps mb-2">{label}</p>
      )}
      {children}
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-blood">
          {error}
        </p>
      )}
    </div>
  );
}

/** A step that suits the amount: one at a time for a few, faster for many. */
const qtyStep = (n: number) => (n >= 100 ? 10 : n >= 20 ? 5 : 1);

/**
 * One task, new or existing: title, status, who does it, what for, the
 * material list (by hand or from a recipe, each line with what the stores
 * hold) and a note. Deleting needs a second tap.
 */
export default function TaskSheet({ task, stock, players, onClose, onUnauthorized }: { task: Task | null; stock: ReadonlyMap<string, number> | null; players: readonly string[]; onClose: () => void; onUnauthorized?: () => void }) {
  const { t, lookup, number } = useI18n();
  const ids = useId();
  const [title, setTitle] = useState(task?.title ?? "");
  const [owner, setOwner] = useState(task?.owner ?? "");
  const [status, setStatus] = useState<Task["status"]>(task?.status ?? "todo");
  const [note, setNote] = useState(task?.note ?? "");
  const [targetKind, setTargetKind] = useState<TargetKind>(task?.target?.kind ?? "none");
  const [boss, setBoss] = useState(task?.target?.kind === "boss" ? task.target.key : BOSSES[0]!.key);
  const [base, setBase] = useState(task?.target?.kind === "base" ? task.target.name : "");
  const [materials, setMaterials] = useState<TaskMaterial[]>(task?.materials ?? []);
  const [adding, setAdding] = useState<null | "recipe" | "item">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: TaskInputError; text: string } | null>(null);
  const [armed, setArmed] = useArmed(false);

  const needs = useMemo(() => (stock ? shortfall(materials, stock) : null), [materials, stock]);
  const full = materials.length >= TASK_LIMITS.materials;

  const target = (): TaskTarget | null => (targetKind === "boss" ? { kind: "boss", key: boss } : targetKind === "base" ? { kind: "base", name: base } : null);
  const input = (): TaskInput => ({ title, owner, status, note, target: target(), materials });

  const failText = (r: Exclude<TaskResult, { ok: true }>) =>
    r.error === "invalid" && r.field ? t(`tasks.error.${r.field}`) : r.error === "too_many" ? t("tasks.error.tooMany", { n: TASK_LIMITS.tasks }) : r.error === "not_found" ? t("tasks.error.gone") : t("tasks.saveFailed");

  const save = async () => {
    if (busy) return;
    const checked = parseTaskInput(input(), false);
    if (!checked.ok) {
      setError({ field: checked.error, text: t(`tasks.error.${checked.error}`) });
      return;
    }
    // An edit sends only what changed here: someone else's change to another field stays.
    const diff = task ? changedFields(task, checked.value as Required<TaskInput>) : checked.value;
    if (task && Object.keys(diff).length === 0) return onClose();
    setBusy(true);
    const r = task ? await updateTask(task.id, diff) : await createTask(diff);
    setBusy(false);
    if (r.ok) onClose();
    else if (r.error === "unauthorized") onUnauthorized?.();
    else setError({ field: r.field, text: failText(r) });
  };

  const remove = async () => {
    if (!task || busy) return;
    if (!armed) {
      navigator.vibrate?.(10);
      setArmed(true);
      return;
    }
    setBusy(true);
    const r = await deleteTask(task.id);
    setBusy(false);
    if (r.ok || r.error === "not_found") onClose();
    else if (r.error === "unauthorized") onUnauthorized?.();
    else setError({ text: failText(r) });
  };

  const recipeLabel = (r: Recipe) => lookup(`tasks.recipe.${r.id}`) ?? r.id;
  const addItem = (item: string) => {
    navigator.vibrate?.(6);
    setMaterials((ms) => {
      const i = ms.findIndex((m) => m.item === item);
      if (i >= 0) return ms.map((m, j) => (j === i ? { ...m, qty: Math.min(TASK_LIMITS.qty, m.qty + 1) } : m));
      return ms.length >= TASK_LIMITS.materials ? ms : [...ms, { item, qty: 1 }];
    });
  };
  const addRecipe = (r: Recipe) => {
    navigator.vibrate?.(6);
    const next = expandRecipe(materials, r);
    // All of a recipe or none of it: a list cut short would understate what is needed.
    if (next.length > TASK_LIMITS.materials) {
      setError({ field: "materials", text: t("tasks.materials.full", { n: TASK_LIMITS.materials }) });
      return;
    }
    setMaterials(next);
    if (error?.field === "materials") setError(null);
    if (r.target?.kind === "boss" && targetKind === "none") {
      setTargetKind("boss");
      setBoss(r.target.key);
    }
    if (!title.trim()) setTitle(recipeLabel(r));
  };
  const setQty = (i: number, qty: number) => setMaterials((ms) => ms.map((m, j) => (j === i ? { ...m, qty } : m)));
  const drop = (i: number) => setMaterials((ms) => ms.filter((_, j) => j !== i));

  const fieldError = (f: TaskInputError) => (error?.field === f ? error.text : null);
  const ownerChips = players.slice(0, OWNER_CHIPS);

  return (
    <Sheet
      labelledBy={`${ids}-h`}
      onClose={onClose}
      width="sm:w-136"
      header={(close) => (
        <div className="flex items-center gap-4 pl-2">
          <span className="slot grid h-14 w-14 shrink-0 place-items-center">
            <StatusMark status={status} size={28} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="label-caps">{t("tasks.kicker")}</p>
            <h2 id={`${ids}-h`} className="plank-title truncate text-2xl">
              {task ? t("tasks.edit") : t("tasks.new")}
            </h2>
          </div>
          <SheetClose label={t("tasks.close")} escLabel={t("key.esc")} onClose={close} />
        </div>
      )}
      footer={
        <div className="material shrink-0 border-t border-iron/50 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-7">
          {error && !error.field && (
            <p role="alert" className="mb-2 text-xs text-blood">
              {error.text}
            </p>
          )}
          <div className="flex items-center gap-2">
            {task && (
              <Btn onClick={() => void remove()} disabled={busy} className={armed ? "text-blood! ring-2 ring-blood" : "text-ash!"}>
                {armed ? t("tasks.deleteConfirm") : t("tasks.delete")}
              </Btn>
            )}
            <span className="flex-1" />
            <Btn primary onClick={() => void save()} disabled={busy}>
              {task ? t("tasks.save") : t("tasks.create")}
            </Btn>
          </div>
        </div>
      }
    >
      <div className="space-y-5 pb-4 text-sm">
        <Field label={t("tasks.field.title")} htmlFor={`${ids}-title`} error={fieldError("title")}>
          <input
            id={`${ids}-title`}
            value={title}
            maxLength={TASK_LIMITS.title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("tasks.field.titleHint")}
            className={`field w-full ${fieldError("title") ? "field-bad" : ""}`}
            autoComplete="off"
            enterKeyHint="done"
          />
        </Field>

        <Field label={t("tasks.field.status")}>
          <div role="group" aria-label={t("tasks.field.status")} className="flex flex-wrap gap-2">
            {TASK_STATUSES.map((s) => (
              <Chip key={s} on={status === s} onClick={() => setStatus(s)}>
                <StatusMark status={s} size={14} />
                {t(`tasks.status.${s}`)}
              </Chip>
            ))}
          </div>
        </Field>

        <Field label={t("tasks.field.owner")} htmlFor={`${ids}-owner`} error={fieldError("owner")}>
          <input
            id={`${ids}-owner`}
            value={owner}
            maxLength={TASK_LIMITS.owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder={t("tasks.field.ownerHint")}
            className="field w-full"
            autoComplete="off"
            enterKeyHint="done"
          />
          {ownerChips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {ownerChips.map((name) => (
                <Chip key={name} on={owner === name} onClick={() => setOwner(owner === name ? "" : name)}>
                  {name}
                </Chip>
              ))}
            </div>
          )}
        </Field>

        <Field label={t("tasks.field.target")} error={fieldError("target")}>
          <div className="flex flex-wrap gap-2">
            {(["none", "boss", "base"] as const).map((k) => (
              <Chip key={k} on={targetKind === k} onClick={() => setTargetKind(k)}>
                {t(`tasks.target.${k}`)}
              </Chip>
            ))}
          </div>
          {targetKind === "boss" && (
            <div role="group" aria-label={t("tasks.target.boss")} className="mt-2 flex flex-wrap gap-2">
              {BOSSES.map((b) => (
                <Chip key={b.key} on={boss === b.key} onClick={() => setBoss(b.key)}>
                  {lookup(`boss.${b.key}`) ?? b.key}
                </Chip>
              ))}
            </div>
          )}
          {targetKind === "base" && (
            <input
              value={base}
              maxLength={TASK_LIMITS.baseName}
              onChange={(e) => setBase(e.target.value)}
              placeholder={t("tasks.target.baseHint")}
              aria-label={t("tasks.target.baseHint")}
              className={`field mt-2 w-full ${fieldError("target") ? "field-bad" : ""}`}
              autoComplete="off"
              enterKeyHint="done"
            />
          )}
        </Field>

        <Field label={t("tasks.field.materials")} error={fieldError("materials")}>
          {materials.length === 0 ? (
            <p className="text-xs text-ash">{t("tasks.materials.empty")}</p>
          ) : (
            <ul className="space-y-2">
              {materials.map((m, i) => {
                const n = needs?.[i];
                const label = itemLabel(m.item, lookup);
                return (
                  <li key={m.item} className="flex items-center gap-2">
                    <span className="slot grid h-11 w-11 shrink-0 place-items-center">
                      <ItemIcon name={m.item} size={22} iconSize={34} className="text-label" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-bold leading-tight text-bone">{label}</span>
                      {n && (
                        <span className={`block text-xs ${n.missing > 0 ? "text-flame" : "text-select-hi"}`}>
                          {n.missing > 0 ? t("tasks.materials.short", { have: number(n.have), missing: number(n.missing) }) : t("tasks.materials.enough", { have: number(n.have) })}
                        </span>
                      )}
                    </span>
                    <Stepper editable label={t("tasks.materials.qty", { item: label })} value={m.qty} min={1} max={TASK_LIMITS.qty} step={qtyStep(m.qty)} onChange={(q) => setQty(i, q)} />
                    <button type="button" onClick={() => drop(i)} aria-label={t("tasks.materials.remove", { item: label })} className="press grid h-11 w-9 place-items-center text-ash hover:text-blood">
                      <svg width="12" height="12" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                        <path d="M3 3l10 10M13 3L3 13" />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {!stock && materials.length > 0 && <p className="mt-2 text-xs text-ash">{t("tasks.storesUnknown")}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Chip on={adding === "recipe"} onClick={() => setAdding(adding === "recipe" ? null : "recipe")} disabled={full}>
              {t("tasks.materials.fromRecipe")}
            </Chip>
            <Chip on={adding === "item"} onClick={() => setAdding(adding === "item" ? null : "item")} disabled={full}>
              {t("tasks.materials.addItem")}
            </Chip>
          </div>
          {full && <p className="mt-2 text-xs text-ash">{t("tasks.materials.full", { n: TASK_LIMITS.materials })}</p>}
          {adding === "recipe" && !full && (
            <div className="mt-3 space-y-3">
              {RECIPE_KINDS.map((kind) => (
                <div key={kind}>
                  <p className="mb-1.5 text-xs text-ash">{t(`tasks.recipeKind.${kind}`)}</p>
                  <div className="flex flex-wrap gap-2">
                    {RECIPES.filter((r) => r.kind === kind).map((r) => (
                      <Chip key={r.id} on={false} onClick={() => addRecipe(r)} title={r.materials.map((x) => `${x.qty} ${itemLabel(x.item, lookup)}`).join(", ")}>
                        {recipeLabel(r)}
                      </Chip>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-xs text-ash">{t("tasks.recipeNote")}</p>
            </div>
          )}
          {adding === "item" && !full && (
            <div className="mt-3 space-y-3">
              <ItemSearch onPick={addItem} selected={(name) => materials.some((m) => m.item === name)} />
            </div>
          )}
        </Field>

        <Field label={t("tasks.field.note")} htmlFor={`${ids}-note`} error={fieldError("note")}>
          <textarea id={`${ids}-note`} value={note} maxLength={TASK_LIMITS.note} rows={3} onChange={(e) => setNote(e.target.value)} placeholder={t("tasks.field.noteHint")} className="field w-full resize-y" />
        </Field>
      </div>
    </Sheet>
  );
}
