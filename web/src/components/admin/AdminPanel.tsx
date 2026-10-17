import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminCatalog } from "../../types";
import { BROADCAST_MAX, gameClock, getCatalog, lockAdmin, storeActorName, storedActorName, testNotify, WORLD_KEYS } from "../../lib/admin";
import { useLivePositions } from "../../lib/live";
import { useI18n, type TextKey } from "../../i18n";
import { ItemIcon } from "../storage/ItemIcon";
import { PlatformGlyph } from "../PlatformGlyph";
import { Sheet } from "../Sheet";
import { targetBody, useAdmin, type Done, type Target } from "./AdminContext";
import { fillResult } from "./FillSheet";
import { AdminGlyph } from "./glyphs";
import { HoldButton } from "./HoldButton";
import { SkaldVersion } from "../SkaldVersion";
import { AdminHead, BridgeBanner, Btn, Chip, HealthBar, Section, TargetChips } from "./parts";
import { AccessLists, RestoreSection } from "./WorldTools";

type Style = "center" | "topleft" | "narrator";
const STYLES: Style[] = ["center", "topleft", "narrator"];
const PRESETS = ["admin.preset.restart5", "admin.preset.boss21", "admin.preset.saving", "admin.preset.raid", "admin.preset.welcome"] as const;

/**
 * The admin sheet: everything the bridge can do to the world, in the order
 * an evening needs it, then the game's admin and ban lists and world
 * restore, which need no bridge. A view-only session says so first, with
 * the unlock. Bridge controls are off (with the reason on top) while it
 * cannot take commands.
 */
export function AdminPanel({ picked, onClose }: { picked?: { x: number; z: number }; onClose: () => void }) {
  const { t } = useI18n();
  const admin = useAdmin();
  const [catalog, setCatalog] = useState<AdminCatalog | null>(null);
  const [name, setName] = useState(storedActorName);
  const reload = useCallback(() => {
    getCatalog()
      .then((r) => r.data && setCatalog(r.data))
      .catch(() => undefined);
  }, []);
  const canRead = !!admin && admin.unlocked && !admin.blocker;
  useEffect(() => {
    if (canRead) reload();
  }, [canRead, reload]);
  if (!admin) return null;
  const st = admin.status;
  const pickedTarget: Target | null = picked ? { at: picked, label: "map" } : null;

  return (
    <Sheet
      labelledBy="admin-h"
      onClose={onClose}
      width="sm:w-xl"
      header={(close) => (
        <AdminHead
          id="admin-h"
          kicker={t("admin.kicker")}
          title={t("admin.title")}
          emblem={<AdminGlyph size={34} className="text-flame" />}
          sub={st?.bridge.gameBuild ? t("admin.sub", { plugin: st.bridge.plugin ?? "?", build: st.bridge.gameBuild }) : admin.bridgeOn ? t("admin.subOff") : t("admin.subFiles")}
          onClose={close}
        />
      )}
    >
      <div className="pb-6">
        {st?.required && !st.unlocked && (
          <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-[3px] border border-ember/50 bg-black/35 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-bold text-flame">{t("admin.you.locked")}</p>
              <p className="mt-1 text-xs text-ash">{t("admin.you.lockedBody")}</p>
            </div>
            <Btn primary onClick={() => void admin.unlock()}>
              {t("admin.you.unlock")}
            </Btn>
          </div>
        )}
        {admin.bridgeOn ? <BridgeTools catalog={catalog} picked={pickedTarget} reload={reload} /> : <p className="mt-2 text-sm text-ash">{t("admin.noBridge")}</p>}

        <Notify />
        <AccessLists />
        <RestoreSection />

        <Section title={t("admin.you")}>
          <label htmlFor="admin-name" className="text-xs text-ash">
            {t("admin.you.name")}
          </label>
          <input
            id="admin-name"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => storeActorName(name)}
            placeholder={t("admin.you.placeholder")}
            className="field mt-1.5 w-full"
            autoComplete="nickname"
          />
          {!st?.required ? (
            <p className="mt-3 text-sm text-ash">{t("admin.you.open")}</p>
          ) : st.unlocked ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <p className="flex-1 text-flame">{t("admin.you.unlocked", { min: Math.round(st.idleMs / 60000) })}</p>
              <Btn onClick={() => void lockAdmin().then(admin.refresh)}>{t("admin.you.lock")}</Btn>
            </div>
          ) : null}
        </Section>
        <SkaldVersion web={admin.versions.web} agent={admin.versions.agent} update={st?.update} className="mt-6 border-t border-iron/25 pt-3" />
      </div>
    </Sheet>
  );
}

/**
 * Discord notifications: on or off, and a test message. Works without the
 * bridge, so its blocker does not disable the button. The webhook URL never
 * reaches the browser.
 */
function Notify() {
  const { t } = useI18n();
  const admin = useAdmin()!;
  const [busy, setBusy] = useState(false);
  const on = admin.status?.notifyConfigured ?? false;
  const send = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let r = await testNotify();
      if (r.needsAdmin && (await admin.unlock())) r = await testNotify();
      if (r.ok) admin.toast(true, t("admin.notify.sent"));
      else if (!r.needsAdmin) admin.toast(false, r.status === 0 ? t("admin.notify.offline") : t("admin.notify.failed", { error: r.error ?? `HTTP ${r.status}` }));
    } catch {
      // signed out; the next poll takes the panel back to the login screen
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("admin.notify.title")} aside={on ? t("admin.notify.aside.on") : t("admin.notify.aside.off")}>
      <p className="mb-2 text-sm text-ash">{on ? t("admin.notify.on") : t("admin.notify.off")}</p>
      {on && (
        <Btn className="w-full" disabled={busy} onClick={() => void send()}>
          {t("admin.notify.test")}
        </Btn>
      )}
    </Section>
  );
}

/** Everything the bridge does to the live world; shown when the agent has a bridge. */
function BridgeTools({ catalog, picked: pickedTarget, reload }: { catalog: AdminCatalog | null; picked: Target | null; reload: () => void }) {
  const { t } = useI18n();
  const admin = useAdmin()!;
  const st = admin.status;
  return (
    <>
      <BridgeBanner />

      <Players />
      <Broadcast />

      <Section title={t("admin.items.title")}>
        <p className="mb-2 text-sm text-ash">{t("admin.items.lead")}</p>
        <Btn
          className="w-full"
          disabled={!!admin.blocker}
          onClick={() => admin.open({ kind: "items", target: pickedTarget ?? (admin.players[0] ? { player: admin.players[0].name } : admin.mainBase ? { at: admin.mainBase, label: "base" } : { at: { x: 0, z: 0 }, label: "map" }) })}
        >
          {t("admin.items.open")}
        </Btn>
      </Section>

      <TimeSection frozen={st?.bridge.timeFrozen ?? false} />
      <Raids catalog={catalog} picked={pickedTarget} onChange={reload} />

      <Section title={t("admin.creatures.title")}>
        <Btn
          className="w-full"
          disabled={!!admin.blocker}
          onClick={() => admin.open({ kind: "creatures", target: pickedTarget ?? (admin.players[0] ? { player: admin.players[0].name } : { at: admin.mainBase ?? { x: 0, z: 0 }, label: "base" }) })}
        >
          {t("admin.creatures.open")}
        </Btn>
      </Section>

      <WorldKeys catalog={catalog} onChange={reload} />
      <BaseHelpers catalog={catalog} picked={pickedTarget} />

      <Section title={t("admin.save.title")}>
        <Btn className="w-full" disabled={!!admin.blocker} onClick={() => void admin.run("save", {}, { done: t("admin.save.done") })}>
          {t("admin.save.now")}
        </Btn>
      </Section>
    </>
  );
}

/** Everyone at the fire, live: tap for their sheet. */
function Players() {
  const { t } = useI18n();
  const admin = useAdmin()!;
  const live = useLivePositions();
  return (
    <Section title={t("admin.players.title")} aside={String(admin.players.length)}>
      {admin.players.length === 0 ? (
        <p className="text-sm text-ash">{t("admin.players.none")}</p>
      ) : (
        <ul className="divide-y divide-iron/25">
          {admin.players.map((p) => {
            const lp = live.players.find((x) => x.name === p.name);
            return (
              <li key={p.name}>
                <button type="button" onClick={() => admin.open({ kind: "player", name: p.name })} className="press flex min-h-12 w-full items-center gap-3 py-1.5 text-left">
                  <PlatformGlyph platform={p.platform} size={16} className="text-label" />
                  <span className="w-28 shrink-0 truncate font-bold text-bone">{p.name}</span>
                  {lp ? <HealthBar health={lp.health} max={lp.maxHealth} className="flex-1" /> : <span className="flex-1 text-xs text-ash">{t("admin.players.noPos")}</span>}
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-ash" aria-hidden>
                    <path d="M6 3l5 5-5 5" />
                  </svg>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** A message on every screen: centre, top-left corner, or the narrator's gold italics. */
function Broadcast() {
  const { t } = useI18n();
  const admin = useAdmin()!;
  const [text, setText] = useState("");
  const [style, setStyle] = useState<Style>("center");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await admin.run("broadcast", { text: text.trim(), type: style }, { done: t("admin.broadcast.sent") });
    setBusy(false);
    if (r.ok) setText("");
  };
  return (
    <Section title={t("admin.broadcast.title")}>
      <div className="relative">
        <textarea
          value={text}
          maxLength={BROADCAST_MAX}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("admin.broadcast.placeholder")}
          aria-label={t("admin.broadcast.title")}
          className={`field w-full resize-none ${style === "narrator" ? "italic text-[#E8C170]" : ""}`}
        />
        <span className="pointer-events-none absolute bottom-2 right-3 text-[0.6875rem] tabular-nums text-ash">{BROADCAST_MAX - text.length}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {PRESETS.map((k) => (
          <Chip key={k} on={false} onClick={() => setText(t(k))} title={t(k)}>
            {t(`${k}.label`)}
          </Chip>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label={t("admin.broadcast.style")} className="flex flex-1 flex-wrap gap-2">
          {STYLES.map((s) => (
            <Chip key={s} on={style === s} onClick={() => setStyle(s)}>
              {t(`admin.broadcast.${s}`)}
            </Chip>
          ))}
        </div>
        <Btn primary disabled={!text.trim() || busy || !!admin.blocker} onClick={() => void send()}>
          {t("admin.broadcast.send")}
        </Btn>
      </div>
      <p className="mt-2 text-xs text-ash">{t("admin.broadcast.noChat")}</p>
    </Section>
  );
}

/** Sun or moon on an arc over the horizon, for a time of day. */
export function SkyDial({ fraction, size = 132 }: { fraction: number; size?: number }) {
  const day = fraction >= 0.25 && fraction < 0.75;
  const th = (fraction - 0.25) * 2 * Math.PI + (day ? 0 : Math.PI);
  const x = 60 - 45 * Math.cos(th);
  const y = 55 - 45 * Math.sin(th);
  const glow = day ? Math.sin(((fraction - 0.25) / 0.5) * Math.PI) : 0;
  return (
    <svg width={size} height={(size * 64) / 120} viewBox="0 0 120 64" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={day ? `rgba(94,151,204,${0.25 + glow * 0.5})` : "rgba(20,26,48,0.9)"} />
          <stop offset="1" stopColor={day ? `rgba(243,184,103,${0.15 + (1 - glow) * 0.35})` : "rgba(46,31,21,0.9)"} />
        </linearGradient>
      </defs>
      <path d="M8 55a52 52 0 0 1 104 0z" fill="url(#sky)" stroke="#6b5745" strokeWidth="1" />
      <path d="M15 55a45 45 0 0 1 90 0" fill="none" stroke="#6b5745" strokeWidth="1" strokeDasharray="2 3" />
      <line x1="2" y1="55" x2="118" y2="55" stroke="#644631" strokeWidth="2" />
      {day ? (
        <circle cx={x} cy={y} r="6" fill="#ecc212" stroke="#ffe58a" strokeWidth="1.5" />
      ) : (
        <path d={`M${x + 4} ${y - 5}a6 6 0 1 0 0 10a5 5 0 1 1 0-10z`} fill="#e6d7b4" />
      )}
    </svg>
  );
}

/** Skip to morning, set a time of day, freeze it. */
function TimeSection({ frozen }: { frozen: boolean }) {
  const { t } = useI18n();
  const admin = useAdmin()!;
  const [fraction, setFraction] = useState(0.5);
  const off = !!admin.blocker;
  return (
    <Section title={t("admin.time.title")} aside={frozen ? t("admin.time.frozen") : undefined}>
      <div className="flex items-center gap-4">
        <SkyDial fraction={fraction} />
        <div className="min-w-0 flex-1">
          <p className="text-2xl font-bold tabular-nums text-bone">{gameClock(fraction)}</p>
          <input
            type="range"
            min={0}
            max={0.999}
            step={1 / 96}
            value={fraction}
            onChange={(e) => setFraction(Number(e.target.value))}
            aria-label={t("admin.time.slider")}
            aria-valuetext={gameClock(fraction)}
            className="range mt-1 w-full"
          />
          <div className="mt-1 flex justify-between text-[0.6875rem] text-ash">
            {[0, 0.25, 0.5, 0.75].map((f) => (
              <button key={f} type="button" onClick={() => setFraction(f)} className="press min-h-8 px-1 tabular-nums hover:text-bone">
                {gameClock(f)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Btn primary disabled={off} onClick={() => void admin.run("time", { dayFraction: Math.round(fraction * 1000) / 1000 }, { done: t("admin.time.setDone", { clock: gameClock(fraction) }) })}>
          {t("admin.time.set", { clock: gameClock(fraction) })}
        </Btn>
        <Btn disabled={off} onClick={() => void admin.run("skip-to-morning", {}, { done: t("admin.time.morningDone") })}>
          {t("admin.time.morning")}
        </Btn>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Btn disabled={off} onClick={() => void admin.run(frozen ? "time-resume" : "time-freeze", {}, { done: frozen ? t("admin.time.resumed") : t("admin.time.frozenDone") }).then(admin.refresh)}>
          {frozen ? t("admin.time.resume") : t("admin.time.freeze")}
        </Btn>
        <p className="flex-1 text-xs text-ash">{t("admin.time.freezeNote")}</p>
      </div>
      <p className="mt-2 text-xs text-ash">{t("admin.time.forward")}</p>
    </Section>
  );
}

/** The running raid with Stop, or start one by its friendly name. */
function Raids({ catalog, picked, onChange }: { catalog: AdminCatalog | null; picked: Target | null; onChange: () => void }) {
  const { t, raidLabel } = useI18n();
  const admin = useAdmin()!;
  const [raid, setRaid] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(picked ?? (admin.players[0] ? { player: admin.players[0].name } : null));
  const off = !!admin.blocker;
  const events = catalog?.events ?? [];
  const cur = catalog?.currentEvent;
  return (
    <Section title={t("admin.raids.title")}>
      {cur ? (
        <div className="mb-3 flex items-center gap-3 rounded-[3px] border border-gold/40 bg-black/30 px-3 py-2">
          <span className="raid-cry flex-1 text-base">{raidLabel(cur.name)}</span>
          <HoldButton disabled={off} onConfirm={() => void admin.run("event-stop", {}, { done: t("admin.raids.stopped") }).then(onChange)}>
            {t("admin.raids.stop")}
          </HoldButton>
        </div>
      ) : (
        <p className="mb-2 text-sm text-ash">{catalog ? t("admin.raids.none") : t("admin.raids.unknown")}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {events.map((e) => (
          <Chip key={e} on={raid === e} onClick={() => setRaid(e)}>
            {raidLabel(e)}
          </Chip>
        ))}
      </div>
      <p className="label-caps mb-2 mt-3">{t("admin.raids.near")}</p>
      <TargetChips value={target} onChange={setTarget} />
      <Btn
        primary
        className="mt-3 w-full"
        disabled={off || !raid || !target}
        onClick={() => raid && target && void admin.run("event-start", { name: raid, ...targetBody(target) }, { done: t("admin.raids.started", { raid: raidLabel(raid) }) }).then(onChange)}
      >
        {raid ? t("admin.raids.start", { raid: raidLabel(raid) }) : t("admin.raids.pick")}
      </Btn>
    </Section>
  );
}

/**
 * A key the switch list does not know, in words. The game stores a world's
 * creation modifiers as one key, "preset combat_default:resources_muchmore:...",
 * which would otherwise run off the screen as a single unbroken string.
 */
export function describeKey(key: string, t: (k: TextKey, v?: Record<string, string | number>) => string, lookup: (k: string) => string | undefined): { title: string; detail: string } {
  const space = key.indexOf(" ");
  const name = space < 0 ? key : key.slice(0, space);
  const value = space < 0 ? "" : key.slice(space + 1);
  if (name === "preset" && value) {
    const parts = value.split(":").flatMap((pair) => {
      const cut = pair.lastIndexOf("_");
      if (cut < 0) return [];
      const mod = pair.slice(0, cut);
      const level = pair.slice(cut + 1);
      if (level === "default") return [];
      return [`${lookup(`mod.${mod}`) ?? mod}: ${lookup(`modv.${level}`) ?? level}`];
    });
    return { title: t("admin.keys.preset"), detail: parts.length ? parts.join(", ") : t("admin.keys.presetDefault") };
  }
  return { title: lookup(`gkey.${name}`) ?? name, detail: value };
}

/** Global keys as switches, explained; boss keys are held to remove, risky ones confirmed. */
function WorldKeys({ catalog, onChange }: { catalog: AdminCatalog | null; onChange: () => void }) {
  const { t, lookup } = useI18n();
  const admin = useAdmin()!;
  const [confirm, setConfirm] = useState<string | null>(null);
  const keys = useMemo(() => new Set((catalog?.globalKeys ?? []).map((k) => k.toLowerCase())), [catalog]);
  const off = !!admin.blocker || !catalog;
  const set = (key: string, on: boolean) => void admin.run(on ? "globalkey-set" : "globalkey-remove", { key }, { done: t(on ? "admin.keys.setDone" : "admin.keys.removed", { key }) }).then(onChange);
  const extra = [...keys].filter((k) => !WORLD_KEYS.some((w) => w.key === k) && !/^activebosses/.test(k));
  return (
    <Section title={t("admin.keys.title")}>
      <ul className="divide-y divide-iron/25">
        {WORLD_KEYS.map(({ key, boss, risky }) => {
          const on = keys.has(key);
          const label = boss ? (lookup(`boss.${key}`) ?? key) : (lookup(`gkey.${key}`) ?? key);
          const why = lookup(`gkey.${key}.why`) ?? (boss ? t("admin.keys.bossWhy", { boss: label }) : "");
          return (
            <li key={key} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-bone">
                  {label} <span className="font-mono text-[0.6875rem] font-normal text-ash">{key}</span>
                </p>
                {why && <p className="text-xs leading-snug text-ash">{why}</p>}
                {confirm === key && <p className="mt-1 text-xs font-bold text-flame">{t("admin.keys.riskyConfirm")}</p>}
              </div>
              {on && boss ? (
                <HoldButton disabled={off} onConfirm={() => set(key, false)}>
                  {t("admin.keys.remove")}
                </HoldButton>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={label}
                  disabled={off}
                  onClick={() => {
                    if (!on && risky && confirm !== key) return setConfirm(key);
                    setConfirm(null);
                    set(key, !on);
                  }}
                  className={`press relative h-8 w-14 shrink-0 rounded-full border transition-colors disabled:opacity-40 coarse:h-11 coarse:w-18 ${on ? "border-select-hi/70 bg-select/50" : confirm === key ? "border-flame bg-ember/30" : "border-iron/60 bg-black/40"}`}
                >
                  <span className={`absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-bone shadow-sm transition-[left] coarse:h-8 coarse:w-8 ${on ? "left-[calc(100%-1.75rem)] coarse:left-[calc(100%-2.25rem)]" : "left-1"}`} />
                </button>
              )}
            </li>
          );
        })}
        {extra.map((key) => {
          const { title, detail } = describeKey(key, t, lookup);
          return (
          <li key={key} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-bone [overflow-wrap:anywhere]">{title}</p>
              {detail && <p className="text-xs leading-snug text-ash [overflow-wrap:anywhere]">{detail}</p>}
            </div>
            <HoldButton danger={false} disabled={off} onConfirm={() => set(key, false)}>
              {t("admin.keys.remove")}
            </HoldButton>
          </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * Repair, fill, grow, reveal the map: around a base or a player, within 100 m.
 * Kilns only ever take wood, so they fill in one tap; smelters and fermenters
 * open a short flow to pick what goes in.
 */
function BaseHelpers({ catalog, picked }: { catalog: AdminCatalog | null; picked: Target | null }) {
  const i18n = useI18n();
  const { t } = i18n;
  const admin = useAdmin()!;
  const [target, setTarget] = useState<Target | null>(picked ?? (admin.mainBase ? { at: admin.mainBase, label: "base" } : admin.players[0] ? { player: admin.players[0].name } : null));
  const off = !!admin.blocker || !target;
  const go = (command: "repair" | "fill-kilns" | "grow" | "map-reveal", done: Done) => target && void admin.run(command, { radius: command === "map-reveal" ? 60 : 50, ...targetBody(target) }, { done });
  const fill = (station: "smelters" | "fermenters") => target && admin.open({ kind: "fill", station, target, catalog });
  return (
    <Section title={t("admin.base.title")}>
      <TargetChips value={target} onChange={setTarget} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Btn disabled={off} onClick={() => go("fill-kilns", (data) => fillResult(i18n, "fill-kilns", data))} className="justify-start pl-2.5 text-left">
          <ItemIcon name="Wood" size={20} iconSize={28} className="text-label" />
          {t("admin.base.fillKilns")}
        </Btn>
        <Btn disabled={off} onClick={() => fill("smelters")} className="justify-start pl-2.5 text-left">
          <ItemIcon name="CopperOre" size={20} iconSize={28} className="text-label" />
          {t("admin.fill.title")}
        </Btn>
        <Btn disabled={off} onClick={() => fill("fermenters")} className="justify-start pl-2.5 text-left">
          <ItemIcon name="MeadBaseTasty" size={20} iconSize={28} className="text-label" />
          {t("admin.ferment.title")}
        </Btn>
        <Btn disabled={off} onClick={() => go("repair", t("admin.base.repaired"))}>
          {t("admin.base.repair")}
        </Btn>
        <Btn disabled={off} onClick={() => go("grow", t("admin.base.grown"))}>
          {t("admin.base.grow")}
        </Btn>
        <Btn disabled={off} onClick={() => go("map-reveal", t("admin.base.revealed"))}>
          {t("admin.base.reveal")}
        </Btn>
      </div>
      <p className="mt-2 text-xs text-ash">{t("admin.base.note")}</p>
    </Section>
  );
}
