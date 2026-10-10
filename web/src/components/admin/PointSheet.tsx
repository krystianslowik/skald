import { useState } from "react";
import { CREATURES } from "../../lib/admin";
import { useI18n } from "../../i18n";
import { PlatformGlyph } from "../PlatformGlyph";
import { Sheet } from "../Sheet";
import { targetBody, useAdmin, type Target } from "./AdminContext";
import { HoldButton } from "./HoldButton";
import { AdminHead, BridgeBanner, Btn, Chip, Section, Stepper, TargetChips } from "./parts";

/** Pin marks the cartography table offers (icon0..icon4). */
const PIN_TYPES = ["icon0", "icon1", "icon2", "icon3", "icon4"] as const;

/** A long press on the map: what can happen at that spot. */
export function PointSheet({ x, z, onClose }: { x: number; z: number; onClose: () => void }) {
  const { t, lookup } = useI18n();
  const admin = useAdmin();
  const [pinName, setPinName] = useState("");
  const [pinType, setPinType] = useState<(typeof PIN_TYPES)[number]>("icon3");
  const [tables, setTables] = useState<Target | null>(admin?.mainBase ? { at: admin.mainBase, label: "base" } : null);
  if (!admin) return null;
  const at = { x: Math.round(x), z: Math.round(z) };
  const off = !!admin.blocker;
  const here = t("admin.target.point", at);

  return (
    <Sheet
      labelledBy="point-h"
      onClose={onClose}
      header={(close) => <AdminHead id="point-h" kicker={t("admin.kicker")} title={t("admin.point.title")} sub={here} emblem={<PinGlyph />} onClose={close} />}
    >
      <div className="pb-4">
        <BridgeBanner compact />
        <Section title={t("admin.point.teleport")}>
          {admin.players.length === 0 ? (
            <p className="text-sm text-ash">{t("admin.target.none")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {admin.players.map((p) => (
                <Chip key={p.name} on={false} disabled={off} onClick={() => void admin.run("teleport", { player: p.name, to: at }, { done: t("admin.player.teleported", { name: p.name, where: here }) })}>
                  <PlatformGlyph platform={p.platform} />
                  {p.name}
                </Chip>
              ))}
            </div>
          )}
        </Section>
        <Section title={t("admin.point.spawn")}>
          <div className="grid grid-cols-2 gap-2">
            <Btn disabled={off} onClick={() => admin.open({ kind: "items", target: { at, label: "map" } })}>
              {t("admin.point.items")}
            </Btn>
            <Btn disabled={off} onClick={() => admin.open({ kind: "creatures", target: { at, label: "map" } })}>
              {t("admin.point.creatures")}
            </Btn>
          </div>
        </Section>
        <Section title={t("admin.point.pin")}>
          <input value={pinName} maxLength={40} onChange={(e) => setPinName(e.target.value)} placeholder={t("admin.point.pinName")} aria-label={t("admin.point.pinName")} className="field w-full" />
          <div role="radiogroup" aria-label={t("admin.point.pinType")} className="mt-2 flex flex-wrap gap-2">
            {PIN_TYPES.map((p) => (
              <Chip key={p} on={pinType === p} onClick={() => setPinType(p)}>
                {lookup(`pin.${p}`) ?? p}
              </Chip>
            ))}
          </div>
          <p className="label-caps mb-2 mt-3">{t("admin.point.tables")}</p>
          <TargetChips value={tables} onChange={setTables} allowMap={false} />
          <p className="mt-2 text-xs text-ash">{t("admin.point.pinNote")}</p>
          <Btn
            primary
            className="mt-3 w-full"
            disabled={off || !pinName.trim() || !tables}
            onClick={() =>
              tables &&
              void admin.run("map-pins", { pins: [{ x: at.x, z: at.z, name: pinName.trim(), type: pinType }], radius: 100, ...targetBody(tables) }, { done: t("admin.point.pinDone", { name: pinName.trim() }) })
            }
          >
            {t("admin.point.pinAdd")}
          </Btn>
        </Section>
      </div>
    </Sheet>
  );
}

/** Spawn creatures next to a player or at a point; clear or tame what is around. */
export function CreatureSheet({ target: initial, onClose }: { target: Target; onClose: () => void }) {
  const { t, lookup } = useI18n();
  const admin = useAdmin();
  const [target, setTarget] = useState<Target>(initial);
  const [prefab, setPrefab] = useState("Boar");
  const [count, setCount] = useState(1);
  const [level, setLevel] = useState(1);
  const [tamed, setTamed] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [radius, setRadius] = useState(30);
  const [bosses, setBosses] = useState(false);
  if (!admin) return null;
  const off = !!admin.blocker;
  const boss = CREATURES.find((c) => c.prefab === prefab)?.boss ?? false;
  const name = lookup(`creature.${prefab}`) ?? prefab;
  const spawn = () => {
    if (boss && !confirm) return setConfirm(true);
    setConfirm(false);
    void admin.run("creature-spawn", { prefab, count, level, tamed, ...targetBody(target) }, { done: t("admin.creatures.spawned", { n: count, name }) });
  };
  return (
    <Sheet
      labelledBy="creatures-h"
      onClose={onClose}
      header={(close) => <AdminHead id="creatures-h" kicker={t("admin.kicker")} title={t("admin.creatures.title")} emblem={<HornGlyph />} onClose={close} />}
    >
      <div className="pb-4">
        <BridgeBanner compact />
        <Section title={t("admin.creatures.where")}>
          <TargetChips value={target} onChange={setTarget} />
        </Section>
        <CreatureFields {...{ prefab, setPrefab: (p: string) => (setPrefab(p), setConfirm(false)), count, setCount, level, setLevel, tamed, setTamed }} />
        {boss && <p className="mt-3 text-sm text-flame">{t("admin.creatures.bossWarn", { name })}</p>}
        <Btn primary className={`mt-3 w-full ${confirm ? "ring-2 ring-flame" : ""}`} disabled={off} onClick={spawn}>
          {confirm ? t("admin.creatures.confirm", { name }) : t("admin.creatures.spawn", { n: count, name })}
        </Btn>

        <Section title={t("admin.creatures.clear")}>
          <label className="flex items-center gap-3 text-sm text-bone">
            <span className="w-28 shrink-0">{t("admin.creatures.radius", { m: radius })}</span>
            <input type="range" min={5} max={100} step={5} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="range flex-1" aria-label={t("admin.creatures.radiusLabel")} />
          </label>
          <label className="mt-2 flex min-h-11 items-center gap-3 text-sm text-bone">
            <input type="checkbox" checked={bosses} onChange={(e) => setBosses(e.target.checked)} className="h-5 w-5 accent-[#5e97cc]" />
            {t("admin.creatures.includeBosses")}
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <HoldButton disabled={off} onConfirm={() => void admin.run("creature-kill", { radius, includeBosses: bosses, ...targetBody(target) }, { done: t("admin.creatures.cleared") })}>
              {t("admin.creatures.kill")}
            </HoldButton>
            <Btn disabled={off} onClick={() => void admin.run("creature-tame", { radius: Math.min(radius, 30), ...targetBody(target) }, { done: t("admin.creatures.tamedDone") })}>
              {t("admin.creatures.tame")}
            </Btn>
          </div>
        </Section>
      </div>
    </Sheet>
  );
}

/** Which creature, how many, how strong, tamed or not. */
export function CreatureFields({
  prefab,
  setPrefab,
  count,
  setCount,
  level,
  setLevel,
  tamed,
  setTamed,
}: {
  prefab: string;
  setPrefab: (p: string) => void;
  count: number;
  setCount: (n: number) => void;
  level: number;
  setLevel: (n: number) => void;
  tamed: boolean;
  setTamed: (b: boolean) => void;
}) {
  const { t, lookup } = useI18n();
  return (
    <>
      <Section title={t("admin.creatures.which")}>
        <div className="flex flex-wrap gap-2">
          {CREATURES.map((c) => (
            <Chip key={c.prefab} on={prefab === c.prefab} onClick={() => setPrefab(c.prefab)}>
              {lookup(`creature.${c.prefab}`) ?? c.prefab}
              {c.boss && <span className="text-[0.625rem] uppercase tracking-wider text-boss">{t("admin.creatures.boss")}</span>}
            </Chip>
          ))}
        </div>
      </Section>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="flex items-center gap-3 text-sm text-bone">
          {t("admin.creatures.count")}
          <Stepper label={t("admin.creatures.count")} value={count} min={1} max={20} onChange={setCount} />
        </label>
        <label className="flex items-center gap-3 text-sm text-bone">
          {t("admin.creatures.level")}
          <Stepper label={t("admin.creatures.level")} value={level} min={1} max={3} onChange={setLevel} format={(n) => (n === 1 ? "0★" : "★".repeat(n - 1))} />
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm text-bone">
          <input type="checkbox" checked={tamed} onChange={(e) => setTamed(e.target.checked)} className="h-5 w-5 accent-[#5e97cc]" />
          {t("admin.creatures.tamed")}
        </label>
      </div>
    </>
  );
}

function PinGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f3b867" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" />
      <circle cx="12" cy="10" r="2.2" />
    </svg>
  );
}

function HornGlyph() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f3b867" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7c3 0 5 2 6 5l2 5h6l1-3c-4 0-6-2-7-6-1-3-4-4-8-1z" />
      <path d="M18 17l2 3" />
    </svg>
  );
}
