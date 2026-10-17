import { useState, type FormEvent } from "react";
import { unlockAdmin } from "../../lib/admin";
import { Unauthorized } from "../../lib/api";
import { useI18n } from "../../i18n";
import { Sheet } from "../Sheet";
import { useAdmin, type AdminView } from "./AdminContext";
import { AdminPanel } from "./AdminPanel";
import { ChestSheet } from "./ChestSheet";
import { ItemPicker } from "./ItemPicker";
import { CreatureSheet, PointSheet } from "./PointSheet";
import { PlayerSheet } from "./PlayerSheet";
import { KeyGlyph } from "./glyphs";
import { AdminHead, Btn } from "./parts";
import { RestoreSheet } from "./WorldTools";

/** Every admin sheet, loaded together on first use. */
export default function AdminSheets({ view, unlocking }: { view: AdminView | null; unlocking: ((ok: boolean) => void) | null }) {
  const admin = useAdmin();
  if (!admin) return null;
  return (
    <>
      {view?.kind === "panel" && <AdminPanel picked={view.picked} onClose={admin.close} />}
      {view?.kind === "player" && <PlayerSheet key={view.name} name={view.name} onClose={admin.close} />}
      {view?.kind === "items" && <ItemPicker target={view.picked ? { at: view.picked, label: "map" } : view.target} lines={view.lines} onClose={admin.close} />}
      {view?.kind === "creatures" && <CreatureSheet target={view.picked ? { at: view.picked, label: "map" } : view.target} onClose={admin.close} />}
      {view?.kind === "point" && <PointSheet x={view.x} z={view.z} onClose={admin.close} />}
      {view?.kind === "chest" && <ChestSheet key={view.chest.id} chest={view.chest} onClose={admin.close} />}
      {view?.kind === "restore" && <RestoreSheet backup={view.backup} onClose={() => admin.open({ kind: "panel" })} />}
      {unlocking && <UnlockSheet onDone={unlocking} />}
    </>
  );
}

/** The admin password, asked for when a command needs it. Rate-limited like the login. */
function UnlockSheet({ onDone }: { onDone: (ok: boolean) => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await unlockAdmin(password);
      if (r.ok) {
        setOk(true);
        return;
      }
      setError(r.retryAfter ? t("admin.unlock.locked", { min: Math.ceil(r.retryAfter / 60) }) : t("admin.unlock.wrong"));
      navigator.vibrate?.([30, 40, 30]);
    } catch (err) {
      setError(err instanceof Unauthorized ? t("admin.unlock.expired") : t("admin.unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      labelledBy="unlock-h"
      onClose={() => onDone(ok)}
      header={(close) => <AdminHead id="unlock-h" kicker={t("admin.kicker")} title={t("admin.unlock.title")} emblem={<KeyGlyph />} onClose={close} />}
    >
      <form onSubmit={(e) => void submit(e)} className="pb-2">
        <p className="mb-4 text-sm text-bone/90">{t("admin.unlock.body")}</p>
        {ok ? (
          <p className="mb-4 font-bold text-flame" role="status">
            {t("admin.unlock.ok")}
          </p>
        ) : (
          <>
            <label htmlFor="admin-pass" className="label-caps mb-1.5 block">
              {t("admin.unlock.label")}
            </label>
            <input
              id="admin-pass"
              data-autofocus
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`field w-full ${error ? "field-bad" : ""}`}
            />
            {error && (
              <p role="alert" className="mt-2 text-sm text-blood">
                {error}
              </p>
            )}
          </>
        )}
        <div className="mt-4 flex gap-3">
          {ok ? (
            <Btn primary onClick={() => onDone(true)} className="flex-1">
              {t("admin.unlock.continue")}
            </Btn>
          ) : (
            <button type="submit" disabled={!password || busy} className="press min-h-11 flex-1 rounded-[3px] border border-white/20 bg-[linear-gradient(180deg,#7aaedc,#5e97cc_60%,#4c82b5)] px-4 text-sm font-bold text-[#10161d] disabled:opacity-40">
              {busy ? t("admin.unlock.busy") : t("admin.unlock.submit")}
            </button>
          )}
        </div>
        <p className="mt-3 text-xs text-ash">{t("admin.unlock.idle")}</p>
      </form>
    </Sheet>
  );
}
