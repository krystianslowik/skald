import { useId, useState, type ReactNode } from "react";
import { cutText, PIN_ICONS, PIN_NAME_MAX, PIN_NOTE_MAX, type PinIcon, type PinState, type WebPin } from "@server/pintypes";
import { useI18n, type TextKey } from "../../i18n";
import { createPin, deletePin, isDone, PIN_ICON_MARK, pinName, sameName, setPinName, updatePin, usePinName, type PinCall } from "../../lib/webpins";
import { RelativeTime } from "../RelativeTime";
import { Sheet, SheetClose } from "../Sheet";
import { MapIcon } from "./MapIcon";
import { STATE_RING } from "./PinLayer";

/** What the pin sheet shows: a new pin at a spot, or one that exists. */
export type PinSheetMode = { kind: "add"; x: number; z: number } | { kind: "view"; id: string };

const ERROR_TEXT: Record<Exclude<PinCall, { ok: true }>["error"], TextKey> = {
  bad_request: "pins.error.bad",
  outside: "pins.error.outside",
  not_archived: "pins.error.notArchived",
  signed_out: "pins.error.signedOut",
  not_found: "pins.error.gone",
  full: "pins.error.full",
  stale: "pins.error.stale",
  bad_move: "pins.error.move",
  rate_limited: "pins.error.slow",
  network: "pins.error.network",
  failed: "pins.error.failed",
};

/**
 * Adds a web pin or shows one: its note, who placed it, its state and what can
 * happen next (claim, cleared, depleted, reopen), editing, archiving and, after
 * a confirm, deleting for good. The viewer's name is asked for once per device.
 */
export function PinSheet({ mode, pins, onClose, onAdded }: { mode: PinSheetMode; pins: readonly WebPin[]; onClose: () => void; onAdded?: (pin: WebPin) => void }) {
  const { t } = useI18n();
  const headingId = useId();
  const pin = mode.kind === "view" ? (pins.find((p) => p.id === mode.id) ?? null) : null;
  const title = mode.kind === "add" ? t("pins.add.title") : pin ? pin.note || t(`pins.icon.${pin.icon}` as TextKey) : t("pins.error.gone");
  return (
    <Sheet
      labelledBy={headingId}
      onClose={onClose}
      header={(close) => (
        <div className="flex items-start gap-3 pl-1">
          {pin && (
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border-[2.5px] bg-[#e6d7b4] ${STATE_RING[pin.state]}`}>
              <MapIcon icon={PIN_ICON_MARK[pin.icon]} size={26} />
            </span>
          )}
          <h2 id={headingId} className="plank-title min-w-0 flex-1 break-words text-lg">
            {title}
          </h2>
          <SheetClose label={t("pins.close")} escLabel={t("key.esc")} onClose={close} />
        </div>
      )}
    >
      {mode.kind === "add" ? (
        <AddPin x={mode.x} z={mode.z} onDone={(p) => (onAdded?.(p), onClose())} onCancel={onClose} />
      ) : pin ? (
        <ViewPin key={pin.id} pin={pin} onClose={onClose} />
      ) : (
        <p className="text-sm text-ash">{t("pins.goneBody")}</p>
      )}
    </Sheet>
  );
}

function Coords({ x, z }: { x: number; z: number }) {
  const { t, number } = useI18n();
  return <p className="font-mono text-xs text-ash">{t("map.coords", { x: number(Math.round(x)), z: number(Math.round(z)) })}</p>;
}

/** The name field, for a device that has none yet. */
function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="label-caps">
        {t("pins.name")}
      </label>
      <input id={id} value={value} onChange={(e) => onChange(cutText(e.target.value, PIN_NAME_MAX))} autoComplete="nickname" className="field mt-1.5 w-full px-3 py-2 text-sm" placeholder={t("pins.namePlaceholder")} />
      <p className="mt-1 text-xs text-ash">{t("pins.nameHint")}</p>
    </div>
  );
}

function IconPicker({ value, onChange }: { value: PinIcon; onChange: (v: PinIcon) => void }) {
  const { t } = useI18n();
  return (
    <fieldset>
      <legend className="label-caps">{t("pins.iconLabel")}</legend>
      <div className="mt-1.5 grid grid-cols-5 gap-1.5">
        {PIN_ICONS.map((icon) => (
          <button
            key={icon}
            type="button"
            aria-pressed={value === icon}
            aria-label={t(`pins.icon.${icon}` as TextKey)}
            title={t(`pins.icon.${icon}` as TextKey)}
            onClick={() => onChange(icon)}
            className="plaque press grid h-11 place-items-center"
          >
            <MapIcon icon={PIN_ICON_MARK[icon]} size={26} />
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function NoteField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="label-caps">
        {t("pins.note")}
      </label>
      {/* One line: the server keeps notes on one line, so the field does not offer more. */}
      <input id={id} type="text" enterKeyHint="done" value={value} onChange={(e) => onChange(cutText(e.target.value, PIN_NOTE_MAX))} className="field mt-1.5 w-full px-3 py-2 text-sm" placeholder={t("pins.notePlaceholder")} />
      <p className="mt-0.5 text-right text-xs tabular-nums text-ash">
        {[...value].length}/{PIN_NOTE_MAX}
      </p>
    </div>
  );
}

function Failure({ error }: { error: PinCall | null }) {
  const { t } = useI18n();
  if (!error || error.ok) return null;
  return (
    <p role="alert" className="text-sm text-blood">
      {t(ERROR_TEXT[error.error])}
    </p>
  );
}

function Action({ children, onClick, disabled, tone = "plain" }: { children: ReactNode; onClick: () => void; disabled?: boolean; tone?: "plain" | "main" | "danger" }) {
  const color = tone === "main" ? "text-flame" : tone === "danger" ? "text-blood" : "text-bone";
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`plaque press min-h-11 px-3 text-sm font-bold disabled:opacity-40 ${color}`}>
      {children}
    </button>
  );
}

function AddPin({ x, z, onDone, onCancel }: { x: number; z: number; onDone: (pin: WebPin) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const saved = usePinName();
  const [name, setName] = useState(saved);
  const [icon, setIcon] = useState<PinIcon>("point");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PinCall | null>(null);
  const by = (saved || name).trim();
  const save = async () => {
    if (!by || busy) return;
    if (!saved) setPinName(by);
    setBusy(true);
    const res = await createPin({ x, z, icon, note: note.trim(), by: pinName() || by });
    setBusy(false);
    if (res.ok && res.pin) onDone(res.pin);
    else setError(res);
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Coords x={x} z={z} />
      {!saved && <NameField value={name} onChange={setName} />}
      <IconPicker value={icon} onChange={setIcon} />
      <NoteField value={note} onChange={setNote} />
      <Failure error={error} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={!by || busy} className="plaque press min-h-11 flex-1 px-4 text-sm font-bold text-flame disabled:opacity-40">
          {t("pins.add.save")}
        </button>
        <Action onClick={onCancel}>{t("pins.cancel")}</Action>
      </div>
      {saved && (
        <p className="text-xs text-ash">
          {t("pins.as", { name: saved })}{" "}
          <button type="button" onClick={() => setPinName("")} className="press-text underline">
            {t("pins.changeName")}
          </button>
        </p>
      )}
    </form>
  );
}

function ViewPin({ pin, onClose }: { pin: WebPin; onClose: () => void }) {
  const { t } = useI18n();
  const saved = usePinName();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PinCall | null>(null);
  const [editing, setEditing] = useState(false);
  const [icon, setIcon] = useState(pin.icon);
  const [note, setNote] = useState(pin.note);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The pin as it was when editing began: someone else's change meanwhile makes the save stale.
  const [base, setBase] = useState(pin);
  const me = saved || name.trim();
  const mine = sameName(pin.claimedBy, me);

  const run = async (call: () => Promise<PinCall>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await call();
    setBusy(false);
    if (!res.ok) setError(res);
    return res;
  };
  /** `from`: the pin as the viewer saw it when deciding (the shown one, or the one an edit began from). */
  const change = (c: { state?: PinState; note?: string; icon?: PinIcon; archived?: boolean }, from: WebPin = pin) => {
    if (!me) return;
    if (!saved) setPinName(me);
    return run(() => updatePin(from, me, c));
  };

  const stateLine =
    pin.state === "claimed"
      ? t("pins.claimedBy", { name: pin.claimedBy ?? "?" })
      : pin.state === "new"
        ? t("pins.state.new")
        : t("pins.doneBy", { state: t(`pins.state.${pin.state}` as TextKey), name: pin.stateBy });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className={`text-sm font-bold ${pin.state === "claimed" ? "text-select-hi" : isDone(pin) ? "text-ash" : "text-flame"}`}>
          {stateLine}
          {pin.state !== "new" && (
            <span className="font-normal text-ash">
              {" "}
              · <RelativeTime iso={new Date(pin.stateAt).toISOString()} />
            </span>
          )}
        </p>
        <p className="text-xs text-label">
          <RelativeTime iso={new Date(pin.createdAt).toISOString()} format={(ago) => t("pins.placedBy", { name: pin.author, ago })} />
        </p>
        <Coords x={pin.x} z={pin.z} />
        {pin.archived && <p className="text-xs font-bold text-ash">{t("pins.archivedNote")}</p>}
      </div>

      {!saved && <NameField value={name} onChange={setName} />}

      {!editing && (
        <div className="flex flex-wrap gap-2">
          {pin.state === "new" && (
            <Action tone="main" disabled={!me || busy} onClick={() => void change({ state: "claimed" })}>
              {t("pins.do.claim")}
            </Action>
          )}
          {pin.state === "claimed" && mine && (
            <Action disabled={!me || busy} onClick={() => void change({ state: "new" })}>
              {t("pins.do.unclaim")}
            </Action>
          )}
          {!isDone(pin) && (
            <>
              <Action tone="main" disabled={!me || busy} onClick={() => void change({ state: "cleared" })}>
                {t("pins.do.cleared")}
              </Action>
              <Action tone="main" disabled={!me || busy} onClick={() => void change({ state: "depleted" })}>
                {t("pins.do.depleted")}
              </Action>
            </>
          )}
          {isDone(pin) && (
            <Action disabled={!me || busy} onClick={() => void change({ state: "new" })}>
              {t("pins.do.reopen")}
            </Action>
          )}
        </div>
      )}

      {editing ? (
        <div className="space-y-4">
          <IconPicker value={icon} onChange={setIcon} />
          <NoteField value={note} onChange={setNote} />
          <div className="flex flex-wrap gap-2">
            <Action
              tone="main"
              disabled={!me || busy}
              onClick={() =>
                void change({ icon, note: note.trim() }, base)?.then((r) => {
                  if (r?.ok) setEditing(false);
                  // Typed text stays; saving again now knowingly replaces the newer copy shown.
                  else if (r?.error === "stale") setBase(r.pin);
                })
              }
            >
              {t("pins.save")}
            </Action>
            <Action
              onClick={() => {
                setEditing(false);
                setIcon(pin.icon);
                setNote(pin.note);
              }}
            >
              {t("pins.cancel")}
            </Action>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 border-t border-iron/30 pt-3">
          <Action
            disabled={busy}
            onClick={() => {
              setIcon(pin.icon);
              setNote(pin.note);
              setBase(pin);
              setEditing(true);
            }}
          >
            {t("pins.edit")}
          </Action>
          <Action disabled={!me || busy} onClick={() => void change({ archived: !pin.archived })}>
            {pin.archived ? t("pins.restore") : t("pins.archive")}
          </Action>
          {/* Only an archived pin is deleted for good, and only after a confirm. */}
          {pin.archived && !confirmDelete && (
            <Action tone="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              {t("pins.delete")}
            </Action>
          )}
        </div>
      )}

      {pin.archived && confirmDelete && (
        <div role="alertdialog" aria-label={t("pins.deleteConfirm")} className="space-y-2 rounded-[2px] border border-blood/50 bg-black/25 p-3">
          <p className="text-sm text-bone">{t("pins.deleteConfirm")}</p>
          <div className="flex flex-wrap gap-2">
            <Action
              tone="danger"
              disabled={busy}
              onClick={() =>
                void run(() => deletePin(pin.id)).then((r) => {
                  if (r?.ok) onClose();
                })
              }
            >
              {t("pins.deleteYes")}
            </Action>
            <Action onClick={() => setConfirmDelete(false)}>{t("pins.deleteNo")}</Action>
          </div>
        </div>
      )}

      <Failure error={error} />
    </div>
  );
}
