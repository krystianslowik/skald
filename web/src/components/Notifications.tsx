import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { lazyChunk, preload } from "../lib/chunks";
import { loadDevice, pushRemembered, savePrefs } from "../lib/push";
import { ChunkBoundary } from "./ErrorBoundary";

const NotifySheet = lazyChunk(() => import("./NotifySheet"), "NotifySheet");
const preloadNotify = () => preload(() => import("./NotifySheet"));

/** A bell; struck through when this device gets no push. */
export function BellGlyph({ size = 18, on = true }: { size?: number; on?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 2h-13z" />
      <path d="M8.2 17.2a2 2 0 0 0 3.6 0" />
      {!on && <path d="M3 3l14 14" />}
    </svg>
  );
}

/**
 * The language a device's notifications speak follows the panel's: when the
 * viewer switches it, a subscribed device tells the server.
 */
function useLocaleFollow() {
  const { locale } = useI18n();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!pushRemembered()) return;
    let live = true;
    void (async () => {
      try {
        const prefs = await loadDevice();
        if (live && prefs && prefs.locale !== locale) await savePrefs({ ...prefs, locale });
      } catch {
        // tried again on the next switch or save
      }
    })();
    return () => {
      live = false;
    };
  }, [locale]);
}

function useSheet() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const sheet = open && (
    <ChunkBoundary overlay onClose={close}>
      <Suspense fallback={null}>
        <NotifySheet onClose={close} />
      </Suspense>
    </ChunkBoundary>
  );
  return { open: () => setOpen(true), sheet };
}

/** Desktop header: next to the sound and embers. */
export function NotifyButton() {
  const { t } = useI18n();
  const { open, sheet } = useSheet();
  useLocaleFollow();
  return (
    <>
      <button
        type="button"
        onClick={open}
        onPointerEnter={preloadNotify}
        onFocus={preloadNotify}
        aria-haspopup="dialog"
        aria-label={t("push.open")}
        title={t("push.open")}
        className="plaque press grid h-8 w-8 place-items-center coarse:h-11 coarse:w-11"
      >
        <BellGlyph />
      </button>
      {sheet}
    </>
  );
}

/** The phone's Settings tab: a row that opens the sheet, with the iPhone note right in it. */
export function NotifyRow() {
  const { t } = useI18n();
  const { open, sheet } = useSheet();
  useLocaleFollow();
  return (
    <>
      <button
        type="button"
        onClick={open}
        onPointerDown={preloadNotify}
        aria-haspopup="dialog"
        className="press flex min-h-14 w-full items-center justify-between gap-4 border-b border-iron/25 py-2 text-left last:border-0"
      >
        <span className="text-bone">
          {t("push.label")}
          <span className="block text-xs text-ash">{t("push.rowHint")}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-ash">
          <BellGlyph />
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 3l5 5-5 5" />
          </svg>
        </span>
      </button>
      {sheet}
    </>
  );
}
