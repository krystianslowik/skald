import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AdminCatalog } from "../../types";
import { getCatalog } from "../../lib/admin";
import { itemLabel, prettify } from "../../lib/storage";
import { useI18n, type I18n } from "../../i18n";
import { Sheet } from "../Sheet";
import { ItemIcon } from "../storage/ItemIcon";
import { targetBody, useAdmin, type FillChoice, type Target } from "./AdminContext";
import { AdminHead, Btn, targetLabel, TargetChips } from "./parts";

type Coal = NonNullable<FillChoice["coal"]>;
type Step = "pick" | "coal" | "confirm" | "done";
type FillCommand = "fill-kilns" | "fill-smelters" | "fill-fermenters";
const KIND: Record<FillCommand, "kilns" | "smelters" | "fermenters"> = { "fill-kilns": "kilns", "fill-smelters": "smelters", "fill-fermenters": "fermenters" };

/**
 * What a fill command really did, from the bridge's answer: how many stations
 * got something, or that the ones there were full or refused the item, or
 * that none were loaded or found. The same cases as the Saga line.
 */
export function fillResult(i: Pick<I18n, "t" | "tn">, command: FillCommand, data: unknown): string {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const kind = KIND[command];
  const num = (k: string) => Number(d[k] ?? 0) || 0;
  const n = num(kind);
  if (n > 0) return i.tn(`admin.fill.result.${kind}`, n);
  if (num("full") + num("skipped") > 0) return i.t(`admin.fill.result.unchanged.${kind}`);
  if (num("unloaded") > 0) return i.t("admin.fill.result.unloaded");
  return i.t(`admin.fill.result.none.${kind}`);
}

const KEEP = "current";
const COAL: Coal[] = ["both", "ore", "coal"];

/**
 * Fill smelters or fermenters as a short guided flow, one screen a step:
 * pick the ore (or mead base) from an icon grid, for smelters say whether
 * coal goes in, then confirm a one-line summary. The choices come from the
 * game (the bridge's station list), so nothing a station refuses is offered.
 */
export function FillSheet({
  station,
  target: initial,
  choice,
  catalog: known,
  onClose,
}: {
  station: "smelters" | "fermenters";
  target: Target;
  choice?: FillChoice;
  /** The catalog the admin panel already holds, if any; fetched otherwise. */
  catalog?: AdminCatalog | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const { t, lookup, intl } = i18n;
  const admin = useAdmin();
  const [catalog, setCatalog] = useState<AdminCatalog | null>(known ?? null);
  const [failed, setFailed] = useState(false);
  const [target, setTargetState] = useState<Target>(initial);
  const closeRef = useRef<(() => void) | null>(null);
  const smelters = station === "smelters";
  const [pick, setPick] = useState<string | null>(choice?.pick ?? null);
  const [coal, setCoal] = useState<Coal | null>(choice?.coal ?? null);
  // Back from picking a spot on the map: straight to the summary.
  const [step, setStep] = useState<Step>(choice?.pick && (!smelters || choice.coal) ? "confirm" : "pick");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // A locked session cannot read the catalog: it asks for the admin password first (below).
  const canRead = !!admin && admin.unlocked;
  const load = useCallback(() => {
    setFailed(false);
    getCatalog()
      .then((r) => (r.data ? setCatalog(r.data) : setFailed(true)))
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    if (canRead && !catalog) load();
  }, [canRead, catalog, load]);
  // Picking a spot on the map closes this sheet and opens it again from the
  // view, so every choice is written there as it is made.
  const remember = (next: { target?: Target; pick?: string | null; coal?: Coal | null }) =>
    admin?.open({ kind: "fill", station, target: next.target ?? target, choice: { pick: next.pick !== undefined ? next.pick : pick, coal: next.coal !== undefined ? next.coal : coal }, catalog });
  const setTarget = (next: Target) => {
    setTargetState(next);
    remember({ target: next });
  };

  const steps: Step[] = smelters ? ["pick", "coal", "confirm"] : ["pick", "confirm"];
  // The result counts as the last step.
  const at = step === "done" ? steps.length - 1 : steps.indexOf(step);
  const fuel = catalog?.stations?.smelters.find((s) => s.fuel)?.fuel ?? "Coal";

  // Every item some station of this kind takes, in the game's order, with the stations that take it.
  const choices = useMemo(() => {
    const list = smelters ? (catalog?.stations?.smelters ?? []) : (catalog?.stations?.fermenters ?? []);
    const by = new Map<string, string[]>();
    for (const s of list) for (const item of s.inputs) by.set(item, [...(by.get(item) ?? []), s.prefab]);
    return [...by].map(([item, prefabs]) => ({ item, prefabs }));
  }, [catalog, smelters]);
  const kinds = new Set(choices.flatMap((c) => c.prefabs)).size;

  const fullLabel = (item: string) => lookup(`admin.fill.item.${item}`) ?? itemLabel(item, lookup);
  // "Mead Base: Tasty" -> "Tasty": the tile is already under "Which mead base?".
  const label = (item: string) => (smelters ? fullLabel(item) : fullLabel(item).replace(/^[^:]+:\s*/, ""));
  const stationName = (prefab: string) => lookup(`admin.fill.station.${prefab}`) ?? prettify(prefab);
  const where = targetLabel(t, target);

  const choose = (item: string) => {
    navigator.vibrate?.(6);
    setPick(item);
    remember({ pick: item });
    setStep(smelters ? "coal" : "confirm");
  };
  const chooseCoal = (c: Coal) => {
    navigator.vibrate?.(6);
    setCoal(c);
    remember({ coal: c });
    setStep("confirm");
  };
  const back = () => setStep(steps[Math.max(0, at - 1)]!);

  const what = (() => {
    if (!smelters) return pick ? fullLabel(pick) : "";
    const coalName = label(fuel).toLocaleLowerCase(intl);
    if (coal === "coal") return t("admin.fill.sum.coalOnly", { coal: coalName });
    const ore = pick === KEEP ? t("admin.fill.sum.current") : pick ? label(pick).toLocaleLowerCase(intl) : "";
    return coal === "both" ? t("admin.fill.sum.and", { ore, coal: coalName }) : ore;
  })();
  const summary = t(smelters ? "admin.fill.sum.smelters" : "admin.fill.sum.fermenters", { where, what });

  const run = async () => {
    if (!admin || busy || !pick || (smelters && !coal)) return;
    setBusy(true);
    const body = smelters ? { radius: 50, what: coal, ...(coal === "coal" ? {} : { ore: pick }) } : { radius: 50, base: pick };
    const command = smelters ? "fill-smelters" : "fill-fermenters";
    const res = await admin.run(command, { ...body, ...targetBody(target) }, { done: (data) => fillResult(i18n, command, data) });
    setBusy(false);
    if (res.ok) {
      setResult(fillResult(i18n, command, res.data));
      setStep("done");
    }
  };
  // From the result: the same fill again, with another choice.
  const again = () => {
    setResult(null);
    setStep("pick");
  };

  const blocked = !!admin?.blocker;
  const title = t(smelters ? "admin.fill.title" : "admin.ferment.title");
  const close = () => (closeRef.current ? closeRef.current() : onClose());
  const emblem = coal === "coal" && smelters ? fuel : pick && pick !== KEEP ? pick : smelters ? (choices[0]?.item ?? "CopperOre") : (choices[0]?.item ?? "MeadBaseTasty");

  return (
    <Sheet
      labelledBy="fill-h"
      onClose={onClose}
      closeRef={closeRef}
      width="sm:w-136"
      header={(close) => (
        <AdminHead
          id="fill-h"
          kicker={t("admin.base.title")}
          title={title}
          sub={`${t("admin.fill.step", { n: at + 1, of: steps.length })} · ${where}`}
          emblem={<ItemIcon name={emblem} size={30} iconSize={44} className="text-flame" />}
          onClose={close}
          wrap
        />
      )}
      footer={
        <div className="material flex shrink-0 items-center gap-2 border-t border-iron/50 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-7">
          {step === "done" ? (
            <Btn onClick={again}>{t("admin.fill.again")}</Btn>
          ) : at > 0 ? (
            <Btn onClick={back}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M10 3L5 8l5 5" />
              </svg>
              {t("admin.fill.back")}
            </Btn>
          ) : (
            <Btn onClick={close}>{t("admin.fill.cancel")}</Btn>
          )}
          <ol aria-hidden className="flex flex-1 justify-center gap-1.5">
            {steps.map((s, i) => (
              <li key={s} className={`h-1.5 w-6 rounded-full ${i <= at ? "bg-flame" : "bg-iron/50"}`} />
            ))}
          </ol>
          {step === "confirm" ? (
            <Btn primary onClick={() => void run()} disabled={busy || blocked}>
              {title}
            </Btn>
          ) : step === "done" ? (
            <Btn primary onClick={close}>
              {t("admin.fill.close")}
            </Btn>
          ) : (
            <span className="min-w-20" />
          )}
        </div>
      }
    >
      <div className="pb-4">
        {step === "pick" && (
          <>
            <Question>{t(smelters ? "admin.fill.ask.ore" : "admin.ferment.ask")}</Question>
            <Grid label={t(smelters ? "admin.fill.ask.ore" : "admin.ferment.ask")}>
              {/* "Keep the current ore" needs the same bridge (0.3.0) as the ore list: a catalog without one, no flow. */}
              {smelters && !(catalog && choices.length === 0) && (
                <Tile on={pick === KEEP} onClick={() => choose(KEEP)} icon={<KeepGlyph />} label={t("admin.fill.current")} />
              )}
              {choices.map((c) => (
                <Tile
                  key={c.item}
                  on={pick === c.item}
                  onClick={() => choose(c.item)}
                  icon={<ItemIcon name={c.item} size={26} iconSize={40} className="text-label" />}
                  label={label(c.item)}
                  note={smelters && kinds > 1 ? c.prefabs.map(stationName).join(", ") : undefined}
                />
              ))}
            </Grid>
            {!canRead && admin && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-xs text-ash">{t("admin.fill.locked")}</p>
                <Btn primary onClick={() => void admin.unlock()}>
                  {t("admin.you.unlock")}
                </Btn>
              </div>
            )}
            {canRead && !catalog && (
              <div role="status" className="mt-3 flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-xs text-ash">{t(failed ? "admin.fill.loadFailed" : "admin.fill.loading")}</p>
                {failed && <Btn onClick={load}>{t("admin.fill.retry")}</Btn>}
              </div>
            )}
            {catalog && choices.length === 0 && <p className="mt-3 text-xs text-ash">{t(smelters ? "admin.fill.noStations" : "admin.ferment.noStations")}</p>}
            {pick === KEEP && <p className="mt-3 text-xs text-ash">{t("admin.fill.currentNote")}</p>}
          </>
        )}

        {step === "coal" && (
          <>
            <Question>{t("admin.fill.ask.coal")}</Question>
            <Grid label={t("admin.fill.ask.coal")} wide>
              {COAL.map((c) => (
                <Tile
                  key={c}
                  on={coal === c}
                  onClick={() => chooseCoal(c)}
                  label={t(`admin.fill.coal.${c}`)}
                  icon={
                    <span className="relative grid place-items-center">
                      {c === "coal" ? <ItemIcon name={fuel} size={26} iconSize={40} className="text-label" /> : pick === KEEP ? <KeepGlyph /> : <ItemIcon name={pick ?? "CopperOre"} size={26} iconSize={40} className="text-label" />}
                      {c === "both" && (
                        <span className="absolute -bottom-1 -right-3">
                          <ItemIcon name={fuel} size={16} iconSize={24} className="text-label" />
                        </span>
                      )}
                    </span>
                  }
                />
              ))}
            </Grid>
          </>
        )}

        {step === "confirm" && (
          <>
            <Question>{t("admin.fill.ask.ok")}</Question>
            <div className="slot flex items-center gap-3 px-3 py-3">
              <span className="flex shrink-0 items-center gap-1">
                {pick && !(smelters && coal === "coal") && (pick === KEEP ? <KeepGlyph /> : <ItemIcon name={pick} size={26} iconSize={40} className="text-label" />)}
                {smelters && coal !== "ore" && <ItemIcon name={fuel} size={26} iconSize={40} className="text-label" />}
              </span>
              <p role="status" className="min-w-0 flex-1 text-sm font-bold leading-snug text-bone">
                {summary}
              </p>
            </div>
            <p className="mt-2 text-xs text-ash">{t(smelters ? (pick === KEEP && coal !== "coal" ? "admin.fill.currentNote" : "admin.fill.okNote") : "admin.ferment.okNote")}</p>
            <p className="label-caps mb-2 mt-5">{t("admin.fill.where")}</p>
            <TargetChips value={target} onChange={setTarget} />
            <p className="mt-2 text-xs text-ash">{t("admin.fill.range")}</p>
          </>
        )}

        {step === "done" && (
          <>
            <Question>{t("admin.fill.result")}</Question>
            <div className="slot px-3 py-3">
              <p role="status" className="text-sm font-bold leading-snug text-bone">
                {result}
              </p>
              <p className="mt-1 text-xs text-ash">{summary}</p>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

function Question({ children }: { children: ReactNode }) {
  return <h3 className="plank-title mb-3 text-lg">{children}</h3>;
}

/** The icon grid the item picker uses: finger-sized slots, as many across as fit. */
function Grid({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <ul aria-label={label} className={`grid gap-2 ${wide ? "grid-cols-3" : "grid-cols-[repeat(auto-fill,minmax(6rem,1fr))]"}`}>
      {children}
    </ul>
  );
}

function Tile({ on, onClick, icon, label, note }: { on: boolean; onClick: () => void; icon: ReactNode; label: string; note?: string }) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={on}
        onClick={onClick}
        className={`press flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-[3px] px-1.5 py-2 ${on ? "slot-selected" : "slot"}`}
      >
        {icon}
        <span className="line-clamp-2 w-full text-center text-xs font-bold leading-tight text-bone">{label}</span>
        {note && <span className="line-clamp-1 w-full text-center text-[0.625rem] leading-tight text-ash">{note}</span>}
      </button>
    </li>
  );
}

/** Two arrows in a circle: keep what each station already holds. */
function KeepGlyph() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-label">
      <path d="M19 9a7.5 7.5 0 0 0-13.5-2.5M5 15a7.5 7.5 0 0 0 13.5 2.5" />
      <path d="M5.5 3v3.5H9M18.5 21v-3.5H15" />
    </svg>
  );
}
