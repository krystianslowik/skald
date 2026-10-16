import { Component, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { isChunkError, page } from "../lib/chunks";

/**
 * What a crashed part of the page shows instead of a blank screen: a short
 * note and a reload button, plus a close button for a sheet that failed.
 */
export function ReloadCard({ overlay = false, stale = false, onClose }: { overlay?: boolean; stale?: boolean; onClose?: () => void }) {
  const { t } = useI18n();
  const card = (
    <div role="alert" className="plank mx-auto max-w-sm px-5 py-5 text-center">
      <p className="plank-title text-base">{t("crash.title")}</p>
      <p className="mt-2 text-sm text-bone/90">{t(stale ? "crash.stale" : "crash.body")}</p>
      <button type="button" onClick={() => page.reload()} className="plaque press mt-4 w-full py-2.5 text-lg font-bold text-flame! hover:text-gold!">
        {t("crash.reload")}
      </button>
      {onClose && (
        <button type="button" onClick={onClose} className="press mt-2 w-full py-2 text-sm text-ash hover:text-bone">
          {t("crash.close")}
        </button>
      )}
    </div>
  );
  // A sheet that failed to open covers the page like the sheet would have.
  if (overlay) return <div className="fixed inset-0 z-50 grid place-items-center bg-coal/80 px-4">{card}</div>;
  return <div className="px-4 py-6">{card}</div>;
}

interface Props {
  children: ReactNode;
  /** Cover the page, for a sheet. */
  overlay?: boolean;
  /** Closes what failed (the sheet) and lets the boundary try again next time. */
  onClose?: () => void;
  /** A new value clears a caught error (the app passes its login state, so a 401 still reaches the login). */
  resetKey?: unknown;
}

/**
 * Catches a render or chunk-load error below it, so one failed part (often a
 * lazy chunk gone after a deploy) shows the reload card instead of unmounting
 * the whole page. Must sit inside the I18nProvider.
 */
export class ChunkBoundary extends Component<Props, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error("unknown") };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private close = () => {
    this.setState({ error: null });
    this.props.onClose?.();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return <ReloadCard overlay={this.props.overlay} stale={isChunkError(this.state.error)} onClose={this.props.onClose ? this.close : undefined} />;
  }
}
