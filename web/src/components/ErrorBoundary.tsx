import { Component, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { ChunkOffline, isChunkError, page, recoverChunk } from "../lib/chunks";

type Cause = "crash" | "stale" | "offline";
const COPY = { crash: "crash.body", stale: "crash.stale", offline: "crash.offline" } as const;

/**
 * What a crashed part of the page shows instead of a blank screen: a short
 * note and a reload button, plus a close button for a sheet that failed.
 */
export function ReloadCard({ overlay = false, cause = "crash", onClose }: { overlay?: boolean; cause?: Cause; onClose?: () => void }) {
  const { t } = useI18n();
  const card = (
    <div role="alert" className="plank mx-auto max-w-sm px-5 py-5 text-center">
      <p className="plank-title text-base">{t(cause === "offline" ? "offline.title" : "crash.title")}</p>
      <p className="mt-2 text-sm text-bone/90">{t(COPY[cause])}</p>
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

interface State {
  error: unknown;
  /** The chunk is still out of reach (offline, server down); cleared when a reload cannot help. */
  offline: boolean;
}

/**
 * Catches a render or chunk-load error below it, so one failed part (often a
 * lazy chunk gone after a deploy) shows the reload card instead of unmounting
 * the whole page. A chunk that failed offline gets the offline note, and the
 * page reloads once the chunk can be fetched again (a lazy chunk cannot be
 * loaded twice in one page). Must sit inside the I18nProvider.
 */
/** Re-checks a chunk lost to an outage the device did not notice (server down, still online): 5 s, 10 s ... up to 60 s. */
const recheckDelay = (n: number) => Math.min(60_000, 5000 * 2 ** n);

export class ChunkBoundary extends Component<Props, State> {
  state: State = { error: null, offline: false };
  private alive = false;
  private trying = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rechecks = 0;

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error("unknown"), offline: error instanceof ChunkOffline };
  }

  componentDidMount() {
    this.alive = true;
    window.addEventListener("online", this.retry);
    this.retryIfOnline();
  }

  componentWillUnmount() {
    this.alive = false;
    clearTimeout(this.timer);
    window.removeEventListener("online", this.retry);
  }

  componentDidUpdate(prev: Props, before: State) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, offline: false });
    else if (this.state.error !== before.error) this.retryIfOnline();
  }

  /**
   * A new offline error: caught once back online (the sheet closed offline and
   * opened later), try at once unless the load itself just found the server
   * down; either way keep checking while the note is up.
   */
  private retryIfOnline() {
    const err = this.state.error;
    if (!this.state.offline || !(err instanceof ChunkOffline)) return;
    this.rechecks = 0;
    const justProbed = err.probed && Date.now() - err.at < 2000;
    if (navigator.onLine !== false && !justProbed) this.retry();
    else this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.retry, recheckDelay(this.rechecks++));
  }

  /** Back online, or a periodic check: reload if the chunk can be fetched now, else keep the note (or say why a reload will not help). */
  private retry = () => {
    const err = this.state.error;
    if (!this.state.offline || !(err instanceof ChunkOffline) || this.trying) return;
    clearTimeout(this.timer);
    this.trying = true;
    void recoverChunk(err.url).then((r) => {
      this.trying = false;
      if (!this.alive || this.state.error !== err) return;
      if (r === false) this.setState({ offline: false });
      else if (r === "down") this.schedule();
    });
  };

  private close = () => {
    clearTimeout(this.timer);
    this.setState({ error: null, offline: false });
    this.props.onClose?.();
  };

  render() {
    const { error, offline } = this.state;
    if (!error) return this.props.children;
    // A chunk lost offline whose reload is held back (one just happened) is not a new build.
    const cause: Cause = offline ? "offline" : isChunkError(error) && !(error instanceof ChunkOffline) ? "stale" : "crash";
    return <ReloadCard overlay={this.props.overlay} cause={cause} onClose={this.props.onClose ? this.close : undefined} />;
  }
}
