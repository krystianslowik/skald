import { AnimatePresence, motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import { memo, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { KEYS, MODIFIER_NAMES, MODIFIERS, NAME_LEN, NEUTRAL_AT, normalize, PRESETS, SAVE_INTERVAL, validatePassword, type ModifierName } from "@server/settings";
import type { SettingsCurrent, SettingsSummary, SettingsView } from "../types";
import { applySettings, cancelApply, getServerPassword, getSettings, isOriginRefusal, putSettings, type SettingsFailure } from "../lib/api";
import { crackle } from "../lib/campfire";
import { diff, draftErrors, draftReducer, generatePassword, isCustom, strength, toInput, worldOnly, type Draft } from "../lib/settingsForm";
import { useI18n, type TextKey } from "../i18n";
import { SETTINGS_PATH, SettingsGlyph } from "./SettingsGlyph";
import { useAdmin } from "./admin/AdminContext";
import { Sheet, SheetClose, SETTLE } from "./Sheet";

const HOLD_MS = 1500;
const SPRING_BACK = { bounce: 0, visualDuration: 0.35 };
const SWAP = { type: "spring" as const, bounce: 0, visualDuration: 0.3 };

type SheetProps = Parameters<typeof SettingsForm>[0];

/**
 * The settings sheet, behind the admin unlock when there is an admin
 * password: a viewer is asked for it first and the sheet stays shut if they
 * cancel (the server refuses the password and every change anyway).
 */
export default function SettingsSheet(props: SheetProps) {
  const admin = useAdmin();
  const locked = !!admin && !admin.unlocked;
  const { onClose } = props;
  const asked = useRef(false);
  const shown = useRef(false);
  // The unlock sheet stays up until it is dismissed; a status poll can
  // report the unlock before that, and the form must not open over it.
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!locked || !admin) return;
    // Locked again (the idle timeout) while open: close rather than ask twice.
    if (asked.current) {
      if (shown.current) onClose();
      return;
    }
    asked.current = true;
    setAsking(true);
    void admin.unlock().then((ok) => {
      setAsking(false);
      if (!ok) onClose();
    });
  }, [locked, admin, onClose]);
  if (locked || asking) return null;
  shown.current = true;
  return <SettingsForm {...props} />;
}

/**
 * Server settings: name, password, public listing, world modifiers and keys,
 * save interval. Inspired by the game's own World Modifiers screen: preset
 * slots in a row, then stepped choices per modifier. Edits stay in a draft;
 * the footer counts them, saves (optimistically, rolled back on error) and
 * then offers to apply: now (press and hold) or once the server is empty.
 */
function SettingsForm({
  summary,
  effectiveName,
  worldModifiers,
  focusFooter,
  onClose,
}: {
  summary: SettingsSummary;
  effectiveName: string;
  /** The modifiers the world save was created with; null when unknown. */
  worldModifiers?: Record<string, string> | null;
  /** Opened from the "restart pending" chip: land on the apply choice. */
  focusFooter: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const reduced = useReducedMotion() ?? false;
  const [view, setView] = useState<SettingsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState<SettingsCurrent | null>(null);
  // Empty until the settings arrive; the first action is always a reset.
  const [draft, dispatch] = useReducer(draftReducer, null as unknown as Draft);
  const [known, setKnown] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [justSaved, setJustSaved] = useState(false);
  const [armedLocal, setArmedLocal] = useState<boolean | null>(null);
  const [applying, setApplying] = useState(false);
  const footer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    getSettings()
      .then((r) => {
        if (!live) return;
        if (r.status !== 200) return setFailed(true);
        setView(r.body);
        setSaved(r.body.current);
        dispatch({ type: "reset", to: r.body.current });
        // Preselect what the world really plays with, so a save keeps it.
        for (const [name, value] of Object.entries(worldOnly(r.body.current, worldModifiers))) {
          dispatch({ type: "modifier", name: name as ModifierName, value });
        }
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // Read once on open: a later state push must not reset the draft.
  }, []);

  // The live summary takes over from local guesses as soon as it moves.
  useEffect(() => {
    if (summary.pending) setJustSaved(false);
    else setApplying(false);
  }, [summary.pending]);
  useEffect(() => setArmedLocal(null), [summary.armed]);

  useEffect(() => {
    if (focusFooter && view) footer.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }, [focusFooter, view]);

  const passwordSet = view?.password.set ?? summary.passwordSet;
  const changes = useMemo(() => (saved && draft ? diff(saved, draft, known) : []), [saved, draft, known]);
  const errors = useMemo(() => {
    if (!saved || !draft) return {};
    return { ...draftErrors(saved, passwordSet, known, draft), ...serverErrors };
  }, [saved, draft, passwordSet, known, serverErrors]);
  const invalid = Object.keys(errors).length > 0;
  const pending = saving || justSaved || summary.pending;
  const armed = armedLocal ?? summary.armed;

  const edit = useCallback((a: Parameters<typeof dispatch>[0]) => {
    dispatch(a);
    setServerErrors({});
    setMessage(null);
  }, []);

  const save = async () => {
    if (!saved || !draft || saving || invalid || changes.length === 0) return;
    const input = toInput(draft, known);
    const before = { saved, known };
    // Optimistic: the bar flips to "apply" at once; a refusal puts it all back.
    setSaving(true);
    setSaved(normalize(input, saved.unmanaged));
    if (input.password) setKnown(input.password);
    setMessage(null);
    try {
      const r = await putSettings(input);
      if (r.status === 200 && "current" in r.body) {
        setView(r.body);
        setSaved(r.body.current);
        dispatch({ type: "reset", to: r.body.current });
        setJustSaved(true);
        setMessage({ tone: "ok", text: t("settings.saved") });
        return;
      }
      const f = r.body as SettingsFailure;
      setSaved(before.saved);
      setKnown(before.known);
      setServerErrors(f.errors ?? {});
      setMessage({ tone: "err", text: f.errors ? t("settings.invalid") : isOriginRefusal(r.status, f) ? t("login.refused") : t("settings.saveFailed", { message: f.message || `HTTP ${r.status}` }) });
    } catch {
      setSaved(before.saved);
      setKnown(before.known);
      setMessage({ tone: "err", text: t("rune.offline") });
    } finally {
      setSaving(false);
    }
  };

  const applyNow = async (): Promise<boolean> => {
    try {
      const r = await applySettings("now");
      if (r.status === 200) {
        setApplying(true);
        setArmedLocal(false);
        setMessage(null);
        return true;
      }
      setMessage({ tone: "err", text: r.status === 409 ? t("rune.busy") : r.status >= 500 ? t("rune.offline") : isOriginRefusal(r.status, r.body) ? t("login.refused") : t("rune.failed") });
    } catch {
      setMessage({ tone: "err", text: t("rune.offline") });
    }
    return false;
  };

  const arm = async (on: boolean) => {
    setArmedLocal(on);
    setMessage(null);
    try {
      const r = on ? await applySettings("when_empty") : await cancelApply();
      if (r.status === 200) return;
      setArmedLocal(null);
      setMessage({ tone: "err", text: r.status >= 500 ? t("rune.offline") : isOriginRefusal(r.status, r.body) ? t("login.refused") : t("rune.failed") });
    } catch {
      setArmedLocal(null);
      setMessage({ tone: "err", text: t("rune.offline") });
    }
  };

  const ready = view && saved && draft;
  // Shown until a save carries the world's modifiers into the settings.
  const worldNote = useMemo(() => (saved ? worldOnly(saved, worldModifiers) : {}), [saved, worldModifiers]);
  return (
    <Sheet
      labelledBy="settings-h"
      onClose={onClose}
      width="sm:w-140"
      header={(close) => (
        <div className="flex items-center gap-4 pl-2">
          <span className="slot grid h-18 w-18 shrink-0 place-items-center">
            <SettingsGlyph size={40} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="label-caps">{t("settings.kicker")}</p>
            <h2 id="settings-h" className="plank-title truncate text-2xl">
              {t("settings.title")}
            </h2>
            <p className="truncate text-xs text-ash">
              {t("settings.running", { name: view?.effective.name || effectiveName })}
              {pending && <span className="text-flame"> · {t("settings.pendingNote")}</span>}
            </p>
          </div>
          <SheetClose label={t("settings.close")} escLabel={t("key.esc")} onClose={close} />
        </div>
      )}
      footer={
        ready ? (
          <div ref={footer} className="material shrink-0 border-t border-iron/50 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-7">
            <Footer
              changes={changes.length}
              invalid={invalid}
              saving={saving}
              pending={pending}
              armed={armed}
              applying={applying}
              message={message}
              onReset={() => {
                edit({ type: "reset", to: saved });
              }}
              onSave={save}
              onApplyNow={applyNow}
              onArm={arm}
            />
          </div>
        ) : undefined
      }
    >
      {failed && <p className="mt-4 text-sm text-ash">{t("settings.failed")}</p>}
      {!ready && !failed && <p className="mt-4 text-sm font-bold uppercase tracking-[0.08em] text-flame">{t("settings.loading")}</p>}
      {ready && (
        <motion.div initial={{ opacity: 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} transition={SETTLE} className="space-y-8 pt-1">
          <Identity name={draft.name} isPublic={draft.public} error={errors.name} savedName={saved.name} edit={edit} />
          <Password password={draft.password} name={draft.name} error={errors.password} passwordSet={passwordSet} known={known} setKnown={setKnown} edit={edit} />
          <WorldModifiers preset={draft.preset} modifiers={draft.modifiers} worldNote={worldNote} edit={edit} />
          <WorldKeys keys={draft.keys} edit={edit} />
          <Advanced saveInterval={draft.saveInterval} unmanaged={saved.unmanaged} hookMissing={view.hook === "missing"} edit={edit} />
        </motion.div>
      )}
    </Sheet>
  );
}

type Edit = (a: Parameters<typeof draftReducer>[1]) => void;

function Section({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="plank-title mb-3 flex items-baseline justify-between gap-3 text-base">
        <span>{title}</span>
        {aside && <span className="text-xs font-normal normal-case tracking-normal text-ash">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

function FieldError({ id, code, field }: { id: string; code: string | undefined; field: string }) {
  const { t, lookup } = useI18n();
  return (
    <p id={id} aria-live="polite" className="mt-1.5 min-h-4 text-xs text-blood">
      {code ? (lookup(`err.${field}.${code}`) ?? t("err.other", { field })) : ""}
    </p>
  );
}

// ---- identity ----------------------------------------------------------------

const Identity = memo(function Identity({
  name,
  isPublic,
  error,
  savedName,
  edit,
}: {
  name: string;
  isPublic: boolean;
  error: string | undefined;
  savedName: string;
  edit: Edit;
}) {
  const { t } = useI18n();
  const id = useId();
  const count = [...name.trim()].length;
  const over = count > NAME_LEN.max;
  return (
    <Section id="settings-identity" title={t("settings.identity")}>
      <div className="flex items-baseline justify-between">
        <label htmlFor={`${id}-name`} className="label-caps">
          {t("settings.name")}
        </label>
        <span aria-hidden className={`text-xs tabular-nums ${over || (count > 0 && count < NAME_LEN.min) ? "text-blood" : "text-ash"}`}>
          {t("settings.count", { n: count, max: NAME_LEN.max })}
        </span>
      </div>
      <input
        id={`${id}-name`}
        type="text"
        value={name}
        maxLength={60}
        spellCheck={false}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-name-err ${id}-name-hint`}
        onChange={(e) => edit({ type: "name", value: e.target.value })}
        className={`field mt-1.5 w-full ${error ? "field-bad" : ""}`}
        placeholder={savedName}
      />
      <p id={`${id}-name-hint`} className="sr-only">
        {t("settings.nameHint")}
      </p>
      <FieldError id={`${id}-name-err`} code={error} field="name" />
      <Check
        checked={isPublic}
        onChange={(on) => edit({ type: "public", value: on })}
        label={t("settings.public")}
        hint={t("settings.publicHint")}
      />
    </Section>
  );
});

/** A square slot checkbox, blue when on, like the game's settings toggles. */
const Check = memo(function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (on: boolean) => void; label: string; hint: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 py-1.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={`${id}-d`}
        onClick={() => onChange(!checked)}
        className={`press tap grid h-7 w-7 shrink-0 place-items-center ${checked ? "slot-selected" : "slot"}`}
      >
        <motion.svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#10161d" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <motion.path d="M3 8.5l3.2 3L13 4.5" initial={false} animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }} transition={SWAP} />
        </motion.svg>
      </button>
      <div className="min-w-0 pt-0.5">
        <p id={`${id}-l`} className="cursor-pointer text-sm font-bold text-bone" onClick={() => onChange(!checked)}>
          {label}
        </p>
        <p id={`${id}-d`} className="text-[0.6875rem] leading-snug text-ash">
          {hint}
        </p>
      </div>
    </div>
  );
});

// ---- password ----------------------------------------------------------------

const Password = memo(function Password({
  password: typed,
  name,
  error,
  passwordSet,
  known,
  setKnown,
  edit,
}: {
  password: string | null;
  name: string;
  error: string | undefined;
  passwordSet: boolean;
  known: string | null;
  setKnown: (pw: string) => void;
  edit: Edit;
}) {
  const { t } = useI18n();
  const id = useId();
  const [holding, setHolding] = useState(false);
  const [showGenerated, setShowGenerated] = useState(false);
  const [copied, setCopied] = useState(false);
  const holdingRef = useRef(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (copiedTimer.current && clearTimeout(copiedTimer.current)), []);

  const fetchKnown = useCallback(async (): Promise<string | null> => {
    if (known !== null) return known;
    try {
      const r = await getServerPassword();
      if (r.status !== 200) return null;
      setKnown(r.body.password);
      return r.body.password;
    } catch {
      return null;
    }
  }, [known, setKnown]);

  // Shown only while pressed. The fetch can outlive the press: the latch
  // decides, so a quick tap never flashes the password after release.
  const startReveal = () => {
    holdingRef.current = true;
    setHolding(true);
    if (typed === null && passwordSet) void fetchKnown();
  };
  const endReveal = () => {
    holdingRef.current = false;
    setHolding(false);
  };

  const revealed = (holding && holdingRef.current) || showGenerated;
  const value = typed ?? (revealed && known !== null ? known : "");
  const changed = typed !== null && typed !== "" && typed !== known;
  const current = typed ?? "";
  const rules = [
    { ok: current.length >= 5 && current.length <= 32, label: t("settings.ruleLength") },
    { ok: current.length > 0 && /^[\x21-\x7e]+$/.test(current), label: t("settings.ruleChars") },
    { ok: current.length > 0 && validatePassword(current, name) !== "inName", label: t("settings.ruleName") },
  ];
  const s = strength(current);

  const copy = async () => {
    const pw = typed || (await fetchKnown());
    if (!pw) return;
    try {
      await navigator.clipboard?.writeText(pw);
    } catch {
      // clipboard denied: nothing else to do
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1800);
  };

  const holdKeys = {
    onKeyDown: (e: KeyboardEvent) => {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) {
        e.preventDefault();
        startReveal();
      }
    },
    onKeyUp: (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") endReveal();
    },
  };

  return (
    <Section id="settings-password" title={t("settings.password")}>
      <div
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            endReveal();
            setShowGenerated(false);
          }
        }}
      >
        <div className="flex items-baseline justify-between">
          <label htmlFor={`${id}-pw`} className="label-caps">
            {t("settings.passwordLabel")}
          </label>
          <span aria-live="polite" className="text-xs text-flame">
            {copied ? t("settings.copied") : ""}
          </span>
        </div>
        <div className="mt-1.5 flex gap-1.5">
          <input
            id={`${id}-pw`}
            type={revealed ? "text" : "password"}
            value={value}
            maxLength={64}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            // Not the dashboard login: keep password managers out of it.
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            placeholder={passwordSet ? `•••••••• (${t("settings.passwordSaved")})` : ""}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-pw-err ${id}-pw-rules`}
            onChange={(e) => {
              setShowGenerated(false);
              edit({ type: "password", value: e.target.value === "" ? null : e.target.value });
            }}
            className={`field min-w-0 flex-1 ${value ? "font-mono tracking-wide" : ""} ${error ? "field-bad" : ""}`}
          />
          <IconButton
            label={t("settings.reveal")}
            pressed={revealed}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              startReveal();
            }}
            onPointerUp={endReveal}
            onPointerLeave={endReveal}
            onPointerCancel={endReveal}
            {...holdKeys}
          >
            <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" />
            <circle cx="10" cy="10" r="2.4" />
          </IconButton>
          <IconButton label={t("settings.copy")} onClick={() => void copy()}>
            <rect x="6.5" y="6.5" width="9" height="10" rx="1" />
            <path d="M4 13.5V4.5a1 1 0 0 1 1-1h7" />
          </IconButton>
          <IconButton
            label={t("settings.generate")}
            onClick={() => {
              edit({ type: "password", value: generatePassword() });
              setShowGenerated(true);
              crackle();
            }}
          >
            {/* Two dice faces: make one up. */}
            <rect x="3" y="3" width="9" height="9" rx="1.5" />
            <path d="M9 13.5V16a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-2.5" />
            <circle cx="6" cy="6" r=".6" fill="currentColor" />
            <circle cx="9" cy="9" r=".6" fill="currentColor" />
            <circle cx="14" cy="14" r=".6" fill="currentColor" />
          </IconButton>
        </div>
        {!passwordSet && typed === null && <p className="mt-1.5 text-xs text-blood">{t("settings.passwordUnknown")}</p>}

        <AnimatePresence initial={false}>
          {typed !== null && (
            <motion.div
              key="rules"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={SWAP}
              className="overflow-hidden"
            >
              <ul id={`${id}-pw-rules`} className="mt-2 grid gap-0.5 text-xs">
                {rules.map((r) => (
                  <li key={r.label} className={`flex items-center gap-1.5 ${r.ok ? "text-bone" : "text-ash"}`}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={r.ok ? "#f3b867" : "#6b5745"} strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                      {r.ok ? <path d="M2 6.5l2.5 2.5L10 3.5" /> : <circle cx="6" cy="6" r="1.4" />}
                    </svg>
                    {r.label}
                  </li>
                ))}
              </ul>
              <div className="mt-2.5 flex items-center gap-3">
                <span className="label-caps">{t("settings.strength")}</span>
                <span className="meter meter-stamina h-2.5 w-28" aria-hidden>
                  <span className="meter-fill" style={{ transform: `scaleX(${s / 3})` }} />
                </span>
                <span className={`text-xs ${s >= 2 ? "text-flame" : "text-ash"}`}>{t(`settings.strength.${s}` as TextKey)}</span>
              </div>
              {changed && (
                <p role="note" className="mt-3 flex items-start gap-2 rounded-[3px] border border-ember/40 bg-black/20 px-3 py-2 text-xs leading-snug text-bone">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#ecc212" strokeWidth="1.6" strokeLinecap="round" className="mt-px shrink-0" aria-hidden>
                    <path d="M8 2l6.5 11.5h-13zM8 6.5v3.2M8 11.6v.2" />
                  </svg>
                  {t("settings.tellFriends")}
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <FieldError id={`${id}-pw-err`} code={error} field="password" />
      </div>
    </Section>
  );
});

function IconButton({
  label,
  pressed,
  children,
  ...rest
}: { label: string; pressed?: boolean; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onContextMenu={(e) => e.preventDefault()}
      className="plaque press grid h-10 w-10 shrink-0 touch-none select-none place-items-center"
      {...rest}
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

// ---- world modifiers ------------------------------------------------------------

// Original line art on a 24x24 box, one mark per preset.
const PRESET_GLYPHS: Record<string, string> = {
  normal: "M12 3l8 3.5v5.5c0 4.6-3.4 8-8 9-4.6-1-8-4.4-8-9V6.5z",
  casual: "M5 19c0-8 5-14 14-14 0 9-6 14-14 14zM5 19l8-8",
  easy: "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4",
  hard: "M4 20L15 9M15 9l1-5 4 4-5 1M20 20L9 9M9 9L8 4 4 8l5 1",
  hardcore: "M12 3a7 7 0 0 0-7 7c0 2.6 1.3 4.2 3 5.2V18h8v-2.8c1.7-1 3-2.6 3-5.2a7 7 0 0 0-7-7zM9.5 11h.01M14.5 11h.01M10.5 18v3M13.5 18v3",
  immersive: "M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zM15.5 8.5l-2 5-5 2 2-5z",
  hammer: "M13 4l7 7-3 3-7-7zM11.5 8.5L3.5 16.5l3 3 8-8",
  custom: SETTINGS_PATH,
};

function PresetGlyph({ id, selected }: { id: string; selected: boolean }) {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={selected ? "#10161d" : "#e0a24a"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PRESET_GLYPHS[id] ?? PRESET_GLYPHS.normal} />
    </svg>
  );
}

const WorldModifiers = memo(function WorldModifiers({
  preset,
  modifiers,
  worldNote,
  edit,
}: {
  preset: string;
  modifiers: Draft["modifiers"];
  /** World modifiers the saved settings lack; preselected in the draft. */
  worldNote: Partial<Record<ModifierName, string>>;
  edit: Edit;
}) {
  const { t, lookup } = useI18n();
  const noted = Object.entries(worldNote).map(([k, v]) => `${lookup(`mod.${k}`) ?? k} ${lookup(`modv.${v}`) ?? v}`);
  const custom = isCustom({ modifiers });
  const presetName = lookup(`preset.${preset}`) ?? preset;
  const description = custom
    ? preset === "normal"
      ? t("settings.customNormal")
      : t("settings.customOn", { preset: presetName })
    : (lookup(`preset.${preset}.hint`) ?? "");
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + PRESETS.length) % PRESETS.length;
    edit({ type: "preset", value: PRESETS[next]! });
    radios.current[next]?.focus();
  };

  return (
    <Section id="settings-world" title={t("settings.world")}>
      <p className="-mt-1 mb-3 text-xs leading-snug text-ash">{t("settings.worldHint")}</p>
      {noted.length > 0 && (
        <p role="note" className="mb-3 flex items-start gap-2 rounded-[3px] border border-ember/40 bg-black/20 px-3 py-2 text-xs leading-snug text-bone">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#ecc212" strokeWidth="1.6" strokeLinecap="round" className="mt-px shrink-0" aria-hidden>
            <path d="M8 2l6.5 11.5h-13zM8 6.5v3.2M8 11.6v.2" />
          </svg>
          {t("settings.worldNote", { list: noted.join(", ") })}
        </p>
      )}
      <div className="grid grid-cols-4 gap-1.5">
        <div role="radiogroup" aria-label={t("settings.presets")} className="contents">
          {PRESETS.map((p, i) => {
            const on = !custom && preset === p;
            return (
              <button
                key={p}
                ref={(el) => void (radios.current[i] = el)}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={(custom ? preset === p : on) ? 0 : -1}
                onClick={() => edit({ type: "preset", value: p })}
                onKeyDown={(e) => onKey(e, i)}
                className={`press relative flex h-17 flex-col items-center justify-center gap-1 transition-shadow hover:shadow-[inset_0_2px_7px_rgba(0,0,0,0.65),inset_0_0_0_1px_rgba(243,184,103,0.55)] ${on ? "slot-selected" : "slot"}`}
              >
                <PresetGlyph id={p} selected={on} />
                <span className={`text-[0.625rem] font-bold uppercase leading-none tracking-[0.06em] ${on ? "text-[#10161d]" : "text-label"}`}>{lookup(`preset.${p}`) ?? p}</span>
              </button>
            );
          })}
        </div>
        {/* Not a choice: lights up when individual modifiers are set, like the game's Custom. */}
        <div aria-hidden className={`flex h-17 flex-col items-center justify-center gap-1 ${custom ? "slot-selected" : "slot opacity-50"}`}>
          <PresetGlyph id="custom" selected={custom} />
          <span className={`text-[0.625rem] font-bold uppercase leading-none tracking-[0.06em] ${custom ? "text-[#10161d]" : "text-ash"}`}>{t("settings.custom")}</span>
        </div>
      </div>
      <div className="mt-2 min-h-9" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p key={description} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.15 }} className="text-sm text-bone">
            {description}
          </motion.p>
        </AnimatePresence>
      </div>
      <div className="mt-2 space-y-4">
        {MODIFIER_NAMES.map((m) => (
          <Stepper key={m} name={m} value={modifiers[m] ?? null} preset={preset} edit={edit} />
        ))}
      </div>
    </Section>
  );
});

/**
 * One modifier as a row of stepped choices, mild to harsh, with the neutral
 * step ("normal", or "preset" under a preset) in its natural place. A radio
 * group: arrows move and select.
 */
const Stepper = memo(function Stepper({ name, value, preset, edit }: { name: ModifierName; value: string | null; preset: string; edit: Edit }) {
  const { t, lookup } = useI18n();
  const labelId = useId();
  const steps = useMemo(() => {
    const vals: (string | null)[] = [...MODIFIERS[name]];
    vals.splice(NEUTRAL_AT[name], 0, null);
    return vals;
  }, [name]);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const neutral = preset === "normal" ? t("settings.neutralNormal") : t("settings.neutralPreset");
  const label = (v: string | null) => (v === null ? neutral : (lookup(`step.${name}.${v}`) ?? v));
  const presetName = lookup(`preset.${preset}`) ?? preset;
  const explain = value === null ? (preset === "normal" ? t("settings.byNormal") : t("settings.byPreset", { preset: presetName })) : (lookup(`setmod.${name}.${value}`) ?? "");
  const selected = steps.indexOf(value);

  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = Math.min(steps.length - 1, Math.max(0, i + d));
    edit({ type: "modifier", name, value: steps[next]! });
    buttons.current[next]?.focus();
  };

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span id={labelId} className="text-sm font-bold text-bone first-letter:uppercase">
          {lookup(`mod.${name}`) ?? name}
        </span>
        <span className={`text-xs font-bold ${value === null ? "text-ash" : "text-flame"}`}>{label(value)}</span>
      </div>
      <div role="radiogroup" aria-labelledby={labelId} className="slot grid auto-cols-fr grid-flow-col gap-0.5 p-[3px]">
        {steps.map((v, i) => {
          const on = i === selected;
          return (
            <button
              key={v ?? "neutral"}
              ref={(el) => void (buttons.current[i] = el)}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => edit({ type: "modifier", name, value: v })}
              onKeyDown={(e) => onKey(e, i)}
              className={`press-soft relative min-h-9 rounded-[2px] px-0.5 coarse:min-h-11 text-[0.6875rem] font-bold leading-tight ${on ? "text-[#10161d]" : v === null ? "text-ash hover:text-flame" : "text-label hover:text-flame"}`}
            >
              {on && <motion.span layoutId={`seg-${name}`} transition={SWAP} className="slot-selected absolute inset-0 rounded-[2px]" />}
              <span className="relative">{label(v)}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[0.6875rem] leading-snug text-ash">{explain}</p>
    </div>
  );
});

// ---- world keys ---------------------------------------------------------------

const WorldKeys = memo(function WorldKeys({ keys, edit }: { keys: string[]; edit: Edit }) {
  const { t, lookup } = useI18n();
  return (
    <Section id="settings-keys" title={t("settings.keys")}>
      <div className="grid gap-1">
        {KEYS.map((k) => (
          <Check
            key={k}
            checked={keys.includes(k)}
            onChange={(on) => edit({ type: "key", key: k, on })}
            label={lookup(`setkey.${k}`) ?? k}
            hint={lookup(`setkey.${k}.hint`) ?? ""}
          />
        ))}
      </div>
    </Section>
  );
});

// ---- advanced -----------------------------------------------------------------

const Advanced = memo(function Advanced({ saveInterval, unmanaged, hookMissing, edit }: { saveInterval: number; unmanaged: string[]; hookMissing: boolean; edit: Edit }) {
  const { t, duration } = useI18n();
  const id = useId();
  const pct = ((saveInterval - SAVE_INTERVAL.min) / (SAVE_INTERVAL.max - SAVE_INTERVAL.min)) * 100;
  return (
    <Section id="settings-advanced" title={t("settings.advanced")}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={`${id}-si`} className="text-sm font-bold text-bone">
          {t("settings.saveInterval")}
        </label>
        <span className="text-sm font-bold tabular-nums text-flame">
          {duration(saveInterval * 1000)}
          {saveInterval === SAVE_INTERVAL.default && <span className="ml-1.5 text-xs font-normal text-ash">({t("settings.saveIntervalDefault")})</span>}
        </span>
      </div>
      <input
        id={`${id}-si`}
        type="range"
        min={SAVE_INTERVAL.min}
        max={SAVE_INTERVAL.max}
        step={60}
        value={saveInterval}
        aria-valuetext={duration(saveInterval * 1000)}
        aria-describedby={`${id}-si-hint`}
        onChange={(e) => edit({ type: "saveInterval", value: Number(e.target.value) })}
        className="range mt-2 w-full"
        style={{ ["--fill" as string]: `${pct}%` }}
      />
      <p id={`${id}-si-hint`} className="mt-1 text-[0.6875rem] leading-snug text-ash">
        {t("settings.saveIntervalHint")}
      </p>
      {unmanaged.length > 0 && (
        <div className="mt-5">
          <p className="label-caps">{t("settings.unmanaged")}</p>
          <div className="slot mt-1.5 flex flex-wrap gap-1.5 px-3 py-2.5">
            {unmanaged.map((tok, i) => (
              <span key={`${i}-${tok}`} className="key-chip font-mono">
                {tok}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[0.6875rem] leading-snug text-ash">{t("settings.unmanagedHint")}</p>
        </div>
      )}
      {hookMissing && <p className="mt-4 text-xs leading-snug text-blood">{t("settings.hookMissing")}</p>}
    </Section>
  );
});

// ---- footer -------------------------------------------------------------------

type FooterProps = {
  changes: number;
  invalid: boolean;
  saving: boolean;
  pending: boolean;
  armed: boolean;
  applying: boolean;
  message: { tone: "ok" | "err"; text: string } | null;
  onReset: () => void;
  onSave: () => void;
  onApplyNow: () => Promise<boolean>;
  onArm: (on: boolean) => void;
};

/**
 * Four states: edits waiting (count, Reset, Save), saved and pending (apply
 * now or when empty), armed (waiting, Cancel), and applying (the restart
 * runs). Edits always win: a new change brings Save back.
 */
function Footer({ changes, invalid, saving, pending, armed, applying, message, onReset, onSave, onApplyNow, onArm }: FooterProps) {
  const { t, tn } = useI18n();
  const mode = changes > 0 || saving ? "edit" : applying ? "applying" : armed ? "armed" : pending ? "apply" : "edit";
  return (
    <div>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div key={mode} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={SWAP}>
          {mode === "edit" && (
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-sm">
                <span className={changes > 0 ? "font-bold text-flame" : "text-ash"}>{changes > 0 ? tn("settings.changes", changes) : t("settings.noChanges")}</span>
              </p>
              <button type="button" onClick={onReset} disabled={changes === 0 || saving} className="plaque press px-3.5 py-2 text-sm font-bold disabled:opacity-40">
                {t("settings.reset")}
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={changes === 0 || invalid || saving}
                className="plaque press border-flame/60 px-5 py-2 text-sm font-bold uppercase tracking-[0.08em] text-flame enabled:shadow-[inset_0_2px_7px_rgba(0,0,0,0.65),0_0_14px_rgba(243,184,103,0.15)] disabled:opacity-40"
              >
                {saving ? t("settings.saving") : t("settings.save")}
              </button>
            </div>
          )}
          {mode === "apply" && (
            <div className="grid gap-2.5 sm:grid-cols-2">
              <HoldButton label={t("settings.applyNow")} hint={t("settings.applyNowHint")} aria={t("settings.applyNowAria")} onFire={onApplyNow} />
              <button type="button" onClick={() => onArm(true)} className="plaque press flex flex-col items-start px-3.5 py-2 text-left">
                <span className="text-sm font-bold text-bone">{t("settings.applyEmpty")}</span>
                <span className="text-[0.6875rem] leading-snug text-ash">{t("settings.applyEmptyHint")}</span>
              </button>
            </div>
          )}
          {mode === "armed" && (
            <div className="flex items-center gap-3">
              <span aria-hidden className="relative grid h-8 w-8 shrink-0 place-items-center">
                <span className="armed-pulse absolute inset-0 rounded-full" />
                <SettingsGlyph size={18} />
              </span>
              <p className="min-w-0 flex-1 text-sm">
                <span className="font-bold text-bone">{t("settings.armed")}</span>
                <br />
                <span className="text-[0.6875rem] text-ash">{t("settings.armedHint")}</span>
              </p>
              <button type="button" onClick={() => onArm(false)} className="plaque press px-3.5 py-2 text-sm font-bold">
                {t("settings.cancel")}
              </button>
            </div>
          )}
          {mode === "applying" && <p className="py-1.5 text-sm font-bold text-flame">{t("settings.applying")}</p>}
        </motion.div>
      </AnimatePresence>
      <p aria-live="polite" className={`mt-1.5 min-h-4 text-xs ${message ? (message.tone === "err" ? "text-blood" : "text-flame") : "text-blood"}`}>
        {message?.text ?? (mode === "edit" && invalid && changes > 0 ? t("settings.invalid") : "")}
      </p>
    </div>
  );
}

/** Apply now: press and hold, like the runes, so nobody restarts by accident. */
function HoldButton({ label, hint, aria, onFire }: { label: string; hint: string; aria: string; onFire: () => Promise<boolean> }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const progress = useSpring(0, reduced ? { bounce: 0, visualDuration: 0.12 } : SPRING_BACK);
  const width = useTransform(progress, (v) => `${v * 100}%`);
  const raf = useRef(0);
  const started = useRef(0);
  const [busy, setBusy] = useState(false);

  const stop = () => {
    cancelAnimationFrame(raf.current);
    if (!busy && progress.get() < 1) progress.set(0);
  };
  const begin = () => {
    if (busy) return;
    started.current = performance.now() - progress.get() * HOLD_MS;
    const tick = () => {
      const p = Math.min(1, (performance.now() - started.current) / HOLD_MS);
      progress.jump(p);
      if (p >= 1) {
        crackle();
        setBusy(true);
        void onFire().then((ok) => {
          setBusy(false);
          if (!ok) progress.set(0);
        });
      } else raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <button
      type="button"
      aria-label={aria}
      disabled={busy}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        begin();
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
      onContextMenu={(e) => e.preventDefault()}
      className="plaque press relative flex touch-none select-none flex-col items-start overflow-hidden px-3.5 py-2 text-left"
    >
      {/* The hold fills the plaque with the game's selection blue. */}
      <motion.span aria-hidden className="slot-selected absolute inset-y-0 left-0" style={{ width }} />
      <span className="relative flex items-center gap-2 text-sm font-bold text-bone">
        <span className="key-chip">{t("key.hold")}</span>
        {label}
      </span>
      <span className="relative text-[0.6875rem] leading-snug text-ash">{hint}</span>
    </button>
  );
}
