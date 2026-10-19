import { useCallback, useEffect, useRef, useState } from "react";
import { PUSH_KINDS, type PushKind, type PushPrefs } from "@server/pushtypes";
import { useI18n } from "../i18n";
import { Unauthorized } from "../lib/api";
import { defaultPrefs, disablePush, enablePush, loadDevice, pushSupport, savePrefs, sendTestPush } from "../lib/push";
import { Row, Switch } from "./Preferences";
import { Sheet, SheetClose } from "./Sheet";

type Note = { kind: "ok" | "error"; text: string } | null;

const DEFAULT_QUIET = { from: "22:00", to: "07:00" };

/**
 * This device's notifications: on or off, which news, and quiet hours. Every
 * change is saved at once; the server keeps the choice with the subscription.
 */
export default function NotifySheet({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const support = pushSupport();
  // undefined: still asking the server; null: this device gets no push.
  const [prefs, setPrefs] = useState<PushPrefs | null | undefined>(support === "ok" ? undefined : null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const denied = support === "ok" && typeof Notification !== "undefined" && Notification.permission === "denied";
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (support !== "ok") return;
    loadDevice()
      .then((p) => live.current && setPrefs(p))
      .catch(() => live.current && setPrefs(null));
  }, [support]);

  const fail = useCallback(
    (e?: unknown) => {
      if (e instanceof Unauthorized) location.reload();
      if (live.current) setNote({ kind: "error", text: t("push.failed") });
    },
    [t],
  );

  const toggleDevice = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      if (prefs) {
        await disablePush();
        if (live.current) setPrefs(null);
      } else {
        const next = defaultPrefs(locale);
        const r = await enablePush(next);
        if (!live.current) return;
        if (r === "ok") setPrefs(next);
        else setNote({ kind: "error", text: r === "denied" ? t("push.denied") : r === "unsupported" ? t("push.unsupported") : r === "full" ? t("push.full") : t("push.failed") });
      }
    } catch (e) {
      fail(e);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  // Saves go one at a time and only the newest choice is sent, so the server
  // never ends on an older one; a failure shows what the server kept.
  const latest = useRef<PushPrefs | null>(null);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const change = (next: PushPrefs) => {
    if (!prefs) return;
    setPrefs(next);
    setNote(null);
    latest.current = { ...next, locale };
    saving.current = saving.current.then(async () => {
      const want = latest.current;
      if (!want) return;
      latest.current = null;
      try {
        if (!(await savePrefs(want))) throw new Error("not saved");
      } catch (e) {
        fail(e);
        const kept = await loadDevice().catch(() => undefined);
        if (live.current && kept !== undefined && latest.current === null) setPrefs(kept);
      }
    });
  };

  const toggleKind = (k: PushKind) => {
    if (!prefs) return;
    const on = prefs.kinds.includes(k);
    change({ ...prefs, kinds: on ? prefs.kinds.filter((x) => x !== k) : PUSH_KINDS.filter((x) => x === k || prefs.kinds.includes(x)) });
  };

  const test = async () => {
    setNote(null);
    try {
      const r = await sendTestPush();
      if (!live.current) return;
      if (r.ok) setNote({ kind: "ok", text: t("push.test.sent") });
      else setNote({ kind: "error", text: r.retryAfter ? t("push.test.wait", { s: r.retryAfter }) : t("push.failed") });
    } catch (e) {
      fail(e);
    }
  };

  const on = !!prefs;
  const quiet = prefs?.quiet ?? null;
  return (
    <Sheet
      labelledBy="notify-h"
      onClose={onClose}
      header={(close) => (
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className="label-caps">{t("push.kicker")}</p>
            <h2 id="notify-h" className="plank-title text-2xl">
              {t("push.label")}
            </h2>
          </div>
          <SheetClose label={t("push.close")} escLabel={t("key.esc")} onClose={close} />
        </div>
      )}
    >
      <div className="pb-4">
        {support === "install" && <p className="mt-3 rounded-[2px] border border-ember/50 bg-black/30 p-3 text-sm text-bone">{t("push.install")}</p>}
        {support === "unsupported" && <p className="mt-3 text-sm text-ash">{t("push.unsupported")}</p>}
        {denied && !on && <p className="mt-3 rounded-[2px] border border-ember/50 bg-black/30 p-3 text-sm text-bone">{t("push.denied")}</p>}
        {support === "ok" && prefs === undefined && <p className="mt-4 text-sm font-bold uppercase tracking-[0.08em] text-flame">{t("push.loading")}</p>}
        {support !== "ok" ? null : prefs === undefined ? null : (
          <>
            <div className="mt-2">
              <Row label={t("push.device")} hint={on ? undefined : t("push.installShort")}>
                <Switch on={on} toggle={() => void toggleDevice()} label={t("push.device")} title={on ? t("push.device.on") : t("push.device.off")} disabled={busy} />
              </Row>
            </div>
            {prefs && (
              <>
                <section aria-labelledby="notify-events-h" className="mt-5">
                  <h3 id="notify-events-h" className="plank-title mb-1 text-base">
                    {t("push.events")}
                  </h3>
                  {PUSH_KINDS.map((k) => (
                    <div key={k}>
                      <Row label={t(`push.kind.${k}`)}>
                        <Switch on={prefs.kinds.includes(k)} toggle={() => toggleKind(k)} label={t(`push.kind.${k}`)} title={t(`push.kind.${k}`)} />
                      </Row>
                      {k === "join" && prefs.kinds.includes("join") && (
                        <div className="pl-5">
                          <Row label={t("push.firstJoin")} hint={t("push.firstJoin.hint")}>
                            <Switch on={prefs.firstJoinOnly} toggle={() => change({ ...prefs, firstJoinOnly: !prefs.firstJoinOnly })} label={t("push.firstJoin")} title={t("push.firstJoin")} />
                          </Row>
                        </div>
                      )}
                    </div>
                  ))}
                </section>
                <section aria-labelledby="notify-quiet-h" className="mt-5">
                  <h3 id="notify-quiet-h" className="sr-only">
                    {t("push.quiet")}
                  </h3>
                  <Row label={t("push.quiet")} hint={t("push.quiet.hint")}>
                    <Switch on={!!quiet} toggle={() => change({ ...prefs, quiet: quiet ? null : DEFAULT_QUIET })} label={t("push.quiet")} title={t("push.quiet")} />
                  </Row>
                  {quiet && (
                    <div className="flex items-end gap-4 py-3">
                      {(["from", "to"] as const).map((end) => (
                        <label key={end} className="flex-1 text-xs text-ash">
                          {t(`push.quiet.${end}`)}
                          <input
                            type="time"
                            required
                            value={quiet[end]}
                            onChange={(e) => {
                              const v = e.target.value.slice(0, 5);
                              if (/^\d\d:\d\d$/.test(v)) change({ ...prefs, quiet: { ...quiet, [end]: v } });
                            }}
                            className="field mt-1.5 w-full px-3 py-2 text-base text-bone coarse:min-h-11"
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </section>
                <button type="button" onClick={() => void test()} className="plaque press mt-5 min-h-12 w-full font-bold">
                  {t("push.test")}
                </button>
              </>
            )}
          </>
        )}
        <p role="status" aria-live="polite" className={`mt-3 min-h-5 text-sm ${note?.kind === "error" ? "text-ember" : "text-ash"}`}>
          {note?.text ?? ""}
        </p>
      </div>
    </Sheet>
  );
}
