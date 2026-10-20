import { useRef, useState } from "react";
import { firesText } from "../../lib/fires";
import { useI18n, type I18n } from "../../i18n";
import { Sheet } from "../Sheet";
import { ItemIcon } from "../storage/ItemIcon";
import { targetBody, useAdmin, type Target } from "./AdminContext";
import { AdminHead, Btn, Chip, TargetChips, targetLabel } from "./parts";

/** The radius choices, in metres; the bridge takes at most 100. */
export const REFUEL_RADII = [20, 50, 100] as const;
const DEFAULT_RADIUS = 50;

/**
 * What a refuel really did, from the bridge's answer: the fires it lit by
 * kind, or that the ones there were full, or that none were loaded or found.
 * The same cases as the Saga line.
 */
export function refuelResult(i: Pick<I18n, "t" | "tn" | "intl">, data: unknown): string {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const num = (k: string) => Number(d[k] ?? 0) || 0;
  if (num("fires") > 0) return i.t("admin.refuel.result", { what: firesText(i, d.byPrefab, num("fires")) });
  if (num("full") > 0) return i.t("admin.refuel.result.full");
  if (num("unloaded") > 0) return i.t("admin.refuel.result.unloaded");
  return i.t("admin.refuel.result.none");
}

/**
 * Refuel every torch, campfire, hearth and brazier around a player or a spot:
 * pick how far, check where, refuel, then the result. One screen; the radius
 * and the place stay put across a trip to the map to pick a spot.
 */
export function RefuelSheet({ target: initial, radius: initialRadius, onClose }: { target: Target; radius?: number; onClose: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const admin = useAdmin();
  const [target, setTargetState] = useState<Target>(initial);
  const [radius, setRadiusState] = useState<number>(initialRadius && (REFUEL_RADII as readonly number[]).includes(initialRadius) ? initialRadius : DEFAULT_RADIUS);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  // Picking a spot on the map closes this sheet and opens it again from the
  // view, so every choice is written there as it is made.
  const remember = (next: { target?: Target; radius?: number }) => admin?.open({ kind: "refuel", target: next.target ?? target, radius: next.radius ?? radius });
  const setTarget = (next: Target) => {
    setTargetState(next);
    remember({ target: next });
  };
  const setRadius = (r: number) => {
    navigator.vibrate?.(6);
    setRadiusState(r);
    remember({ radius: r });
  };

  const where = targetLabel(t, target);
  const summary = t("admin.refuel.sum", { where, r: radius });
  const title = t("admin.refuel.title");
  const blocked = !!admin?.blocker;
  const close = () => (closeRef.current ? closeRef.current() : onClose());

  const run = async () => {
    if (!admin || busy) return;
    setBusy(true);
    const res = await admin.run("refuel-fires", { radius, ...targetBody(target) }, { done: (data) => refuelResult(i18n, data) });
    setBusy(false);
    if (res.ok) setResult(refuelResult(i18n, res.data));
  };

  return (
    <Sheet
      labelledBy="refuel-h"
      onClose={onClose}
      closeRef={closeRef}
      width="sm:w-136"
      header={(close) => <AdminHead id="refuel-h" kicker={t("admin.base.title")} title={title} sub={where} emblem={<ItemIcon name="Torch" size={30} iconSize={44} className="text-flame" />} onClose={close} wrap />}
      footer={
        <div className="material flex shrink-0 items-center justify-between gap-2 border-t border-iron/50 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-7">
          {result ? <Btn onClick={() => setResult(null)}>{t("admin.refuel.again")}</Btn> : <Btn onClick={close}>{t("admin.fill.cancel")}</Btn>}
          {result ? (
            <Btn primary onClick={close}>
              {t("admin.fill.close")}
            </Btn>
          ) : (
            <Btn primary onClick={() => void run()} disabled={busy || blocked}>
              {title}
            </Btn>
          )}
        </div>
      }
    >
      <div className="pb-4">
        {result ? (
          <>
            <h3 className="plank-title mb-3 text-lg">{t("admin.fill.result")}</h3>
            <div className="slot px-3 py-3">
              <p role="status" className="text-sm font-bold leading-snug text-bone">
                {result}
              </p>
              <p className="mt-1 text-xs text-ash">{summary}</p>
            </div>
          </>
        ) : (
          <>
            <h3 id="refuel-radius" className="plank-title mb-3 text-lg">
              {t("admin.refuel.ask.radius")}
            </h3>
            <div role="group" aria-labelledby="refuel-radius" className="flex flex-wrap gap-2">
              {REFUEL_RADII.map((r) => (
                <Chip key={r} on={radius === r} onClick={() => setRadius(r)}>
                  {t("admin.refuel.metres", { n: r })}
                </Chip>
              ))}
            </div>
            <p className="label-caps mb-2 mt-5">{t("admin.refuel.where")}</p>
            <TargetChips value={target} onChange={setTarget} />
            <div className="slot mt-5 flex items-center gap-3 px-3 py-3">
              <ItemIcon name="Torch" size={26} iconSize={40} className="text-label" />
              <p role="status" className="min-w-0 flex-1 text-sm font-bold leading-snug text-bone">
                {summary}
              </p>
            </div>
            <p className="mt-2 text-xs text-ash">{t("admin.refuel.note")}</p>
          </>
        )}
      </div>
    </Sheet>
  );
}
