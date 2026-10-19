import { useEffect, useId, useState, type ReactNode } from "react";
import type { Platform } from "../../types";
import { useI18n, type TextKey } from "../../i18n";
import { PlatformGlyph } from "../PlatformGlyph";
import { SheetClose } from "../Sheet";
import { BLOCKER_TEXT, useAdmin, type Target } from "./AdminContext";
import { HoldButton } from "./HoldButton";
import { gameVersion } from "../../lib/format";

/**
 * The second-tap confirm's state: armed by the first tap, disarmed by itself
 * after `ms` so a switch left armed cannot fire on a much later stray tap.
 */
export function useArmed<T>(idle: T, ms = 6000): [T, (v: T) => void] {
  const [armed, setArmed] = useState(idle);
  useEffect(() => {
    if (armed === idle) return;
    const timer = setTimeout(() => setArmed(idle), ms);
    return () => clearTimeout(timer);
  }, [armed, idle, ms]);
  return [armed, setArmed];
}

/** A titled block inside an admin sheet. */
export function Section({ title, aside, children, id }: { title: string; aside?: ReactNode; children: ReactNode; id?: string }) {
  const auto = useId();
  const hid = `${id ?? auto}-h`;
  return (
    <section aria-labelledby={hid} className="mt-6 first:mt-2">
      <div className="mb-2.5 flex items-baseline gap-3">
        <h3 id={hid} className="plank-title text-base">
          {title}
        </h3>
        <span aria-hidden className="h-px flex-1 bg-linear-to-r from-iron/60 to-transparent" />
        {aside && <span className="text-xs text-ash">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * The header every admin sheet shares: an emblem slot, kicker, title, close.
 * `wrap` lets a long title take a second, smaller line on a phone instead of
 * being cut off.
 */
export function AdminHead({ id, kicker, title, sub, emblem, onClose, wrap = false }: { id: string; kicker: string; title: ReactNode; sub?: ReactNode; emblem: ReactNode; onClose: () => void; wrap?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-4 pl-2">
      <span className="slot grid h-16 w-16 shrink-0 place-items-center">{emblem}</span>
      <div className="min-w-0 flex-1">
        <p className="label-caps">{kicker}</p>
        <h2 id={id} className={`plank-title ${wrap ? "text-xl leading-tight sm:text-2xl" : "truncate text-2xl"}`}>
          {title}
        </h2>
        {sub && <div className="truncate text-xs text-ash">{sub}</div>}
      </div>
      <SheetClose label={t("admin.close")} escLabel={t("key.esc")} onClose={onClose} />
    </div>
  );
}

/** A plain action button at finger size. */
export function Btn({
  children,
  onClick,
  disabled,
  primary = false,
  className = "",
  title,
  describedBy,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  className?: string;
  title?: string;
  /** Id of the visible line that says why the button is off. */
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-describedby={describedBy}
      className={`press flex min-h-11 items-center justify-center gap-2 rounded-[3px] px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 ${
        primary ? "border border-white/20 bg-[linear-gradient(180deg,#7aaedc,#5e97cc_60%,#4c82b5)] text-[#10161d]" : "plaque"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** A selectable chip (radio-like), 44 px tall on touch. */
export function Chip({ on, onClick, children, disabled, title }: { on: boolean; onClick: () => void; children: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`press inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-bold coarse:min-h-11 disabled:opacity-40 ${
        on ? "border-select-hi/70 bg-select/30 text-bone" : "border-iron/60 bg-black/25 text-ash hover:text-bone"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * - n + with bounds, finger sized. `editable`: the number is a field too, so
 * an exact amount can be typed (committed on Enter or leaving the field).
 */
export function Stepper({ value, min, max, onChange, label, step = 1, format, editable = false }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string; step?: number; format?: (n: number) => string; editable?: boolean }) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  // What is being typed; null while the field shows the value itself.
  const [draft, setDraft] = useState<string | null>(null);
  // A change from elsewhere (a button, a kit) wins over half-typed digits.
  useEffect(() => setDraft(null), [value]);
  const commit = () => {
    if (draft === null) return;
    const n = parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(n) && clamp(n) !== value) onChange(clamp(n));
  };
  return (
    <div role="group" aria-label={label} className="inline-flex items-center">
      <button type="button" aria-label={`${label} -`} disabled={value <= min} onClick={() => onChange(clamp(value - step))} className="plaque press grid h-11 w-11 place-items-center rounded-r-none text-lg font-bold disabled:opacity-40">
        −
      </button>
      {editable ? (
        <input
          type="text"
          inputMode="numeric"
          enterKeyHint="done"
          aria-label={label}
          value={draft ?? String(value)}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape" && draft !== null) {
              // Drop the typing, not the sheet.
              e.stopPropagation();
              setDraft(null);
            }
          }}
          className="slot h-11 w-12 px-1 text-center font-bold tabular-nums text-bone underline decoration-iron decoration-dotted underline-offset-4 outline-none focus:decoration-flame"
        />
      ) : (
        <output aria-live="polite" className="slot grid h-11 min-w-10 place-items-center px-1.5 font-bold tabular-nums text-bone">
          {format ? format(value) : value}
        </output>
      )}
      <button type="button" aria-label={`${label} +`} disabled={value >= max} onClick={() => onChange(clamp(value + step))} className="plaque press grid h-11 w-11 place-items-center rounded-l-none text-lg font-bold disabled:opacity-40">
        +
      </button>
    </div>
  );
}

/**
 * Where a command acts: one of the players at the fire, the main base, or a
 * point picked on the map.
 */
export function TargetChips({ value, onChange, allowBase = true, allowMap = true, exclude }: { value: Target | null; onChange: (t: Target) => void; allowBase?: boolean; allowMap?: boolean; exclude?: string }) {
  const { t } = useI18n();
  const admin = useAdmin();
  if (!admin) return null;
  const isPlayer = (n: string) => !!value && "player" in value && value.player === n;
  const atLabel = value && "at" in value ? value.label : undefined;
  return (
    <div className="flex flex-wrap gap-2">
      {admin.players
        .filter((p) => p.name !== exclude)
        .map((p) => (
          <Chip key={p.id ?? p.name} on={isPlayer(p.name)} onClick={() => onChange({ player: p.name })}>
            <PlatformGlyph platform={p.platform} />
            {p.name}
          </Chip>
        ))}
      {allowBase && admin.mainBase && (
        <Chip on={atLabel === "base"} onClick={() => onChange({ at: admin.mainBase!, label: "base" })}>
          {t("admin.target.base")}
        </Chip>
      )}
      {value && "at" in value && atLabel === "map" && (
        <Chip on onClick={() => undefined}>
          {t("admin.target.point", { x: Math.round(value.at.x), z: Math.round(value.at.z) })}
        </Chip>
      )}
      {allowMap && (
        <Chip on={false} onClick={() => admin.startPick({ label: t("admin.pick.generic") })}>
          {t("admin.target.map")}
        </Chip>
      )}
      {admin.players.length === 0 && !admin.mainBase && <span className="text-sm text-ash">{t("admin.target.none")}</span>}
    </div>
  );
}

/** Why the controls are off, with the one thing that can be done about it. */
export function BridgeBanner({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const admin = useAdmin();
  if (!admin?.blocker) return null;
  const b = admin.status?.bridge;
  // The raw build goes to the agent; people read it without the "l-" prefix.
  const build = b?.gameBuild ?? "?";
  const shown = gameVersion(b?.gameBuild);
  return (
    <div role="status" className={`rounded-[3px] border border-ember/50 bg-black/35 ${compact ? "px-3 py-2" : "px-4 py-3"} text-sm`}>
      <p className="font-bold text-flame">{t(BLOCKER_TEXT[admin.blocker], { build: shown })}</p>
      {!compact && admin.blocker === "disabled" && (
        <>
          <p className="mt-1 text-xs text-bone">{t("admin.disabled.body")}</p>
          {b?.message && <p className="mt-1 wrap-break-word font-mono text-[11px] text-ash/80">{t("admin.disabled.detail", { message: b.message })}</p>}
        </>
      )}
      {!compact && admin.blocker === "untested" && (
        <div className="mt-2">
          <p className="mb-2 text-xs text-ash">{t("admin.untested.body", { tested: (b?.testedBuilds ?? []).map(gameVersion).join(", ") || "-" })}</p>
          <HoldButton danger={false} onConfirm={() => void admin.run("ack-build", { build }, { done: t("admin.untested.done", { build: shown }) }).then(() => admin.refresh())}>
            {t("admin.untested.allow", { build: shown })}
          </HoldButton>
        </div>
      )}
    </div>
  );
}

/** A health bar like the game's: red on dark. */
export function HealthBar({ health, max, className = "" }: { health: number | null; max: number | null; className?: string }) {
  const { t, number } = useI18n();
  if (health == null || !max) return null;
  const pct = Math.max(0, Math.min(1, health / max));
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div role="meter" aria-label={t("admin.health")} aria-valuemin={0} aria-valuemax={max} aria-valuenow={health} className="h-2 flex-1 overflow-hidden rounded-full border border-black/60 bg-black/50">
        <div className="h-full rounded-full bg-[linear-gradient(180deg,#e2453f,#9c1f24)]" style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="text-xs tabular-nums text-ash">
        {number(health)}/{number(max)}
      </span>
    </div>
  );
}

/** A player's platform; undefined when the name is not online, or when players sharing it are on different platforms. */
export function platformOf(players: { name: string; platform?: Platform }[], name: string): Platform | undefined {
  const all = new Set(players.filter((p) => p.name === name).map((p) => p.platform));
  return all.size === 1 ? [...all][0] : undefined;
}
