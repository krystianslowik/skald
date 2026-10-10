import { useState } from "react";
import { useLivePositions } from "../../lib/live";
import { useI18n } from "../../i18n";
import { PlatformGlyph } from "../PlatformGlyph";
import { Sheet } from "../Sheet";
import { Shield } from "../Shield";
import { useAdmin } from "./AdminContext";
import { HoldButton } from "./HoldButton";
import { AdminHead, BridgeBanner, Btn, Chip, HealthBar, Section, platformOf } from "./parts";

/** Teleport spots the plugin knows by alias (bridge/README.md). */
export const SPOTS = ["spawn", "eikthyr", "elder", "bonemass", "moder", "yagluth", "queen", "fader", "haldor", "hildir", "bogwitch"] as const;

/**
 * One player at the fire: where they are, their health, and what an admin
 * can do for (or to) them.
 */
export function PlayerSheet({ name, onClose }: { name: string; onClose: () => void }) {
  const { t, lookup } = useI18n();
  const admin = useAdmin();
  const live = useLivePositions();
  const [banName, setBanName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  if (!admin) return null;
  const me = live.players.find((p) => p.name === name);
  const platform = me?.platform ?? platformOf(admin.players, name);
  const here = admin.players.some((p) => p.name === name);
  const off = !!admin.blocker || !here;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };
  const teleport = (body: Record<string, unknown>, where: string) =>
    act("tp", () => admin.run("teleport", { player: name, ...body }, { done: t("admin.player.teleported", { name, where }) }));

  return (
    <Sheet
      labelledBy="player-h"
      onClose={onClose}
      header={(close) => (
        <AdminHead
          id="player-h"
          kicker={t("admin.player.kicker")}
          title={name}
          emblem={<Shield name={name} size={50} />}
          sub={
            <span className="flex items-center gap-1.5">
              {platform && platform !== "unknown" && (
                <>
                  <PlatformGlyph platform={platform} className="text-label" />
                  <span>{t(`platform.${platform}`)}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              {here ? (me ? t("admin.player.at", { x: Math.round(me.x), z: Math.round(me.z) }) : t("profile.atFireNow")) : t("admin.player.gone")}
            </span>
          }
          onClose={close}
        />
      )}
    >
      <div className="pb-4">
        {me && <HealthBar health={me.health} max={me.maxHealth} className="mb-3" />}
        <BridgeBanner compact />

        <Section title={t("admin.player.teleport")}>
          <div className="flex flex-wrap gap-2">
            {admin.mainBase && (
              <Chip on={false} disabled={off || busy === "tp"} onClick={() => void teleport({ to: admin.mainBase }, t("admin.target.base"))}>
                {t("admin.target.base")}
              </Chip>
            )}
            {admin.players
              .filter((p) => p.name !== name)
              .map((p) => (
                <Chip key={p.name} on={false} disabled={off || busy === "tp"} onClick={() => void teleport({ toPlayer: p.name }, p.name)}>
                  <PlatformGlyph platform={p.platform} />
                  {t("admin.player.toPlayer", { name: p.name })}
                </Chip>
              ))}
            <Chip
              on={false}
              disabled={off}
              onClick={() =>
                admin.startPick({
                  label: t("admin.pick.teleport", { name }),
                  onPick: (p) => void admin.run("teleport", { player: name, to: { x: Math.round(p.x), z: Math.round(p.z) } }, { done: t("admin.player.teleported", { name, where: t("admin.target.point", { x: Math.round(p.x), z: Math.round(p.z) }) }) }),
                })
              }
            >
              {t("admin.target.map")}
            </Chip>
          </div>
          <details className="group mt-2">
            <summary className="press inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-sm font-bold text-flame">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="transition-transform group-open:rotate-90">
                <path d="M6 3l5 5-5 5" />
              </svg>
              {t("admin.player.spots")}
            </summary>
            <div className="mt-1 flex flex-wrap gap-2">
              {SPOTS.map((s) => (
                <Chip key={s} on={false} disabled={off || busy === "tp"} onClick={() => void teleport({ toSpot: s }, lookup(`spot.${s}`) ?? s)}>
                  {lookup(`spot.${s}`) ?? s}
                </Chip>
              ))}
            </div>
          </details>
        </Section>

        <Section title={t("admin.player.help")}>
          <div className="grid grid-cols-2 gap-2">
            <Btn disabled={off} onClick={() => admin.open({ kind: "items", target: { player: name } })}>
              {t("admin.player.give")}
            </Btn>
            <Btn disabled={off} onClick={() => admin.open({ kind: "creatures", target: { player: name } })}>
              {t("admin.player.creatures")}
            </Btn>
            <Btn disabled={off || busy === "heal"} onClick={() => void act("heal", () => admin.run("heal", { player: name }, { done: t("admin.player.healed", { name }) }))}>
              {t("admin.player.heal")}
            </Btn>
            <Btn disabled={off || busy === "rested"} onClick={() => void act("rested", () => admin.run("status", { player: name, effect: "Rested" }, { done: t("admin.player.restedDone", { name }) }))}>
              {t("admin.player.rested")}
            </Btn>
          </div>
        </Section>

        <Section title={t("admin.player.discipline")}>
          <div className="space-y-3">
            <HoldButton disabled={off} className="w-full" onConfirm={() => void admin.run("kick", { player: name }, { done: t("admin.player.kicked", { name }) })}>
              {t("admin.player.kick", { name })}
            </HoldButton>
            <div className="rounded-[3px] border border-blood/30 bg-black/25 p-3">
              <label htmlFor="ban-name" className="text-xs text-ash">
                {t("admin.player.banType", { name })}
              </label>
              <input
                id="ban-name"
                value={banName}
                onChange={(e) => setBanName(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={name}
                className="field mt-1.5 w-full"
              />
              <HoldButton
                disabled={off || banName.trim() !== name}
                className="mt-2 w-full"
                onConfirm={() => void admin.run("ban", { player: name }, { done: t("admin.player.banned", { name }) }).then((r) => r.ok && onClose())}
              >
                {t("admin.player.ban", { name })}
              </HoldButton>
            </div>
          </div>
        </Section>
      </div>
    </Sheet>
  );
}
