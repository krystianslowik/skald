import { createContext, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AdminCatalog, AdminCommand, AdminStatus, AgentEvent, ApiState, CompatView, MapContainer, Platform, RestoreBackup } from "../../types";
import { getAdminStatus, postAdmin, runAdmin, type AdminOutcome, type KitLine } from "../../lib/admin";
import { Unauthorized } from "../../lib/api";
import { failText } from "../../lib/refusal";
import { useWorldMap } from "../../lib/useWorldMap";
import { useI18n, type TextKey } from "../../i18n";
import { compareVersions } from "@server/version";
import { lazyChunk, preload } from "../../lib/chunks";
import { ChunkBoundary } from "../ErrorBoundary";

const AdminSheets = lazyChunk(() => import("./AdminSheets"), "AdminSheets");
export const preloadAdmin = () => preload(() => import("./AdminSheets"));

/** Where a command acts: next to a player, or at a point of the world. */
export type Target = { player: string } | { at: { x: number; z: number }; label?: string };

export const targetBody = (t: Target): Record<string, unknown> => ("player" in t ? { player: t.player } : { at: { x: Math.round(t.at.x), z: Math.round(t.at.z) } });

/** The success toast: fixed, or built from what the command answered. */
export type Done = string | ((data: unknown) => string);

/** What a fill flow has picked so far, kept in the view so a map pick does not lose it. */
export interface FillChoice {
  pick: string | null;
  coal: "both" | "ore" | "coal" | null;
}

/** A part of the admin sheet it can open at (the compatibility notice's details). */
export type PanelSection = "compat";

/**
 * A sheet the admin layer shows; only one at a time, the unlock sheet over
 * any. `picked` is a point just picked on the map for it (the sheet steps
 * aside while the map is open, then comes back with it).
 */
export type AdminView = (
  | { kind: "panel"; section?: PanelSection }
  | { kind: "player"; name: string }
  | { kind: "items"; target: Target; lines?: KitLine[] }
  | { kind: "creatures"; target: Target }
  | { kind: "point"; x: number; z: number }
  | { kind: "restore"; backup: RestoreBackup }
  | { kind: "fill"; station: "smelters" | "fermenters"; target: Target; choice?: FillChoice; catalog?: AdminCatalog | null }
  | { kind: "chest"; chest: MapContainer }
) & { picked?: { x: number; z: number } };

/** A map tap someone is waiting for (teleport here, spawn here). */
export interface PickRequest {
  label: string;
  /** Runs with the point; the sheet that asked comes back either way. */
  onPick?: (p: { x: number; z: number }) => void;
}

export interface Toast {
  id: number;
  ok: boolean;
  text: string;
}

/** Why controls are off, for the banner and the disabled buttons; null when they work. */
export type Blocker = "off" | "unreachable" | "disabled" | "token" | "loading" | "restarting" | "agent" | "untested" | "offline" | null;

/** Why the controls are off, one line per blocker (the banner, the chest's Add item). */
export const BLOCKER_TEXT: Record<Exclude<Blocker, null>, TextKey> = {
  off: "admin.blocker.off",
  unreachable: "admin.blocker.unreachable",
  disabled: "admin.blocker.disabled",
  token: "admin.blocker.token",
  loading: "admin.blocker.loading",
  restarting: "admin.blocker.restarting",
  agent: "admin.blocker.agent",
  untested: "admin.blocker.untested",
  offline: "admin.blocker.offline",
};

/** Whether the bridge plugin is known and older than `version` (an unknown version is given the benefit of the doubt). */
export function pluginBelow(status: AdminStatus | null | undefined, version: string): boolean {
  const plugin = status?.bridge.plugin;
  return !!plugin && compareVersions(plugin, version) === -1;
}

export interface Admin {
  status: AdminStatus | null;
  /**
   * The admin layer is there: the web tier answered. The access lists and
   * world restore need no bridge, so the panel shows even without one.
   */
  present: boolean;
  /** The agent has a bridge (working or not); without one only the file tools show. */
  bridgeOn: boolean;
  blocker: Blocker;
  /** May command now (no admin password, or unlocked). */
  unlocked: boolean;
  refresh(): void;
  run(command: AdminCommand, body?: Record<string, unknown>, opts?: { quiet?: boolean; done?: Done }): Promise<AdminOutcome>;
  /** Any other admin POST (lists, restore), with the same unlock-and-retry and toasts. */
  post(path: string, body: Record<string, unknown>, opts?: { quiet?: boolean; done?: Done }): Promise<AdminOutcome>;
  open(view: AdminView): void;
  close(): void;
  /** Ask for the admin password; resolves true once unlocked. */
  unlock(): Promise<boolean>;
  /** Wait for a tap on the map (the map opens); null cancels. */
  pick: PickRequest | null;
  startPick(req: PickRequest): void;
  /** The map's answer to a pick: runs it, then brings the sheet back. */
  completePick(p: { x: number; z: number }): void;
  cancelPick(): void;
  toast(ok: boolean, text: string): void;
  /** Players at the fire, for the target pickers. */
  players: { name: string; platform?: Platform }[];
  mainBase: { x: number; z: number } | null;
  /** The world's name, which a restore asks to have typed. */
  world: string;
  /** Recent events, for following a restore's steps. */
  events: AgentEvent[];
  /** Skald releases of this panel and of the agent (missing from agents before 2026.10.0). */
  versions: { web: string; agent?: string };
  /** The compatibility check with the game build; null from agents before it. */
  compat: CompatView | null;
}

const AdminCtx = createContext<Admin | null>(null);

/**
 * A view-only session: an admin password is set and this session has not
 * unlocked it. False until the first admin status arrives, so a panel whose
 * status cannot be read keeps working as before (the server still refuses).
 */
export const viewOnly = (admin: Admin | null | undefined): boolean => !!admin?.present && !admin.unlocked;

/** The admin layer, or null outside the provider (tests, the login screen). */
export const useAdmin = (): Admin | null => useContext(AdminCtx);

export function AdminProvider({
  state,
  online,
  onUnauthorized,
  onShowMap,
  children,
}: {
  state: ApiState;
  online: boolean;
  onUnauthorized: () => void;
  onShowMap: () => void;
  children: ReactNode;
}) {
  const i18n = useI18n();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [view, setView] = useState<AdminView | null>(null);
  const [unlocking, setUnlocking] = useState<((ok: boolean) => void) | null>(null);
  const [pick, setPick] = useState<PickRequest | null>(null);
  const pickFrom = useRef<AdminView | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const unauth = useRef(onUnauthorized);
  unauth.current = onUnauthorized;

  const refresh = useCallback(() => {
    getAdminStatus()
      .then(setStatus)
      .catch((e) => {
        if (e instanceof Unauthorized) unauth.current();
      });
  }, []);

  // Status now, on every server state change, and every 20 s (the idle timeout and a patched game show up).
  // A hidden tab skips the 20 s ticks and asks again when it is looked at.
  const serverStatus = state.server.status;
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 20_000);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, serverStatus, online]);

  const toast = useCallback((ok: boolean, text: string) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts.slice(-2), { id, ok, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), ok ? 3500 : 6000);
  }, []);

  // Everyone waiting on the one unlock sheet (a rune and the settings sheet can
  // both ask) hears its answer; a second ask must not orphan the first.
  const waiting = useRef<((ok: boolean) => void)[]>([]);
  const unlock = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        waiting.current.push(resolve);
        setUnlocking(() => (ok: boolean) => {
          setUnlocking(null);
          if (ok) refresh();
          const all = waiting.current;
          waiting.current = [];
          for (const w of all) w(ok);
        });
      }),
    [refresh],
  );

  const call = useCallback(
    async (send: () => Promise<AdminOutcome>, opts: { quiet?: boolean; done?: Done } = {}) => {
      let res: AdminOutcome;
      try {
        res = await send();
        if (res.needsAdmin && (await unlock())) res = await send();
      } catch (e) {
        if (e instanceof Unauthorized) unauth.current();
        return { ok: false, status: 401 };
      }
      if (!res.ok && res.status === 409) refresh();
      if (!opts.quiet) {
        if (res.ok) toast(true, (typeof opts.done === "function" ? opts.done(res.data) : opts.done) ?? i18n.t("admin.done"));
        else if (!res.needsAdmin) toast(false, failText(i18n, res));
      }
      return res;
    },
    [unlock, refresh, toast, i18n],
  );
  const run = useCallback<Admin["run"]>((command, body = {}, opts) => call(() => runAdmin(command, body), opts), [call]);
  const post = useCallback<Admin["post"]>((path, body, opts) => call(() => postAdmin(path, body), opts), [call]);

  const startPick = useCallback(
    (req: PickRequest) => {
      setView((v) => {
        // Coming back from the map returns to the tools, not to the section the sheet first opened at.
        pickFrom.current = v?.kind === "panel" ? { ...v, section: undefined } : v;
        return null;
      });
      setPick(req);
      onShowMap();
    },
    [onShowMap],
  );
  const completePick = useCallback(
    (p: { x: number; z: number }) => {
      const req = pick;
      setPick(null);
      req?.onPick?.(p);
      const back = pickFrom.current;
      pickFrom.current = null;
      if (back) setView({ ...back, picked: p });
    },
    [pick],
  );
  const cancelPick = useCallback(() => {
    setPick(null);
    const back = pickFrom.current;
    pickFrom.current = null;
    if (back) setView({ ...back, picked: undefined });
  }, []);

  // The main base (most pieces) of the saved map: the default target of base helpers.
  const saveKey = state.world.meta?.savedAt ?? "";
  const [load] = useWorldMap(saveKey);
  const mainBase = useMemo(() => {
    if (load.status !== "ready") return null;
    let best: { x: number; z: number; pieces: number } | null = null;
    for (const b of load.map.bases) if (!best || b.pieces > best.pieces) best = b;
    return best ? { x: best.x, z: best.z } : null;
  }, [load]);

  const bridge = status?.bridge;
  const present = !!status;
  const bridgeOn = !!bridge && bridge.reason !== "off";
  let blocker: Blocker = null;
  if (!online) blocker = "offline";
  else if (!bridge) blocker = "agent";
  else if (!bridge.available) blocker = bridge.reason ?? "unreachable";
  else if (!bridge.tested && !bridge.acknowledged) blocker = "untested";
  const unlocked = !status?.required || status.unlocked;

  const webVersion = state.webVersion ?? "dev";
  const agentVersion = state.agent.version;
  const versions = useMemo(() => ({ web: webVersion, agent: agentVersion }), [webVersion, agentVersion]);
  const value = useMemo<Admin>(
    () => ({
      status,
      present,
      bridgeOn,
      blocker,
      unlocked,
      refresh,
      run,
      post,
      open: setView,
      close: () => setView(null),
      unlock,
      pick,
      startPick,
      completePick,
      cancelPick,
      toast,
      players: state.players,
      mainBase,
      world: state.server.world,
      events: state.history.events,
      versions,
      compat: state.compat ?? null,
    }),
    [status, present, bridgeOn, blocker, unlocked, refresh, run, post, unlock, pick, startPick, completePick, cancelPick, toast, state.players, mainBase, state.server.world, state.history.events, versions, state.compat],
  );

  return (
    <AdminCtx.Provider value={value}>
      {children}
      {(view || unlocking) && (
        <ChunkBoundary
          overlay
          onClose={() => {
            unlocking?.(false);
            setView(null);
          }}
        >
          <Suspense fallback={null}>
            <AdminSheets view={view} unlocking={unlocking} />
          </Suspense>
        </ChunkBoundary>
      )}
      <Toasts toasts={toasts} />
    </AdminCtx.Provider>
  );
}

/** Gap between a sheet's header and the first toast (px). */
const TOAST_GAP = 8;

/**
 * Where the toast stack starts (px from the top), given the open sheets'
 * headers: just under the lowest one that sits in the top half of the screen,
 * so a sheet's title and close button stay in view. A peeking sheet's header
 * lower down is left alone. Null: no such sheet, the stack keeps its default top.
 */
export function toastTop(headers: readonly { top: number; bottom: number }[], viewportHeight: number): number | null {
  const under = headers.filter((h) => h.bottom > 0 && h.top < viewportHeight / 2).map((h) => h.bottom);
  return under.length ? Math.max(...under) + TOAST_GAP : null;
}

function Toasts({ toasts }: { toasts: Toast[] }) {
  const [top, setTop] = useState<number | null>(null);
  const shown = toasts.length > 0;
  // Sheets are portaled to the body and their headers are the dialog's own <header>. While toasts
  // show, the stack follows them every frame: a sheet that opens, closes, slides or is dragged.
  useLayoutEffect(() => {
    if (!shown) {
      setTop(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      const headers = [...document.querySelectorAll<HTMLElement>('[role="dialog"] > header')].map((h) => h.getBoundingClientRect());
      setTop(toastTop(headers, window.innerHeight));
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" style={top === null ? undefined : { top }} className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-60 flex flex-col items-center gap-2 px-4">
      {toasts.map((x) => (
        <p
          key={x.id}
          role={x.ok ? "status" : "alert"}
          className={`material toast-in max-w-md rounded-[3px] border px-4 py-2.5 text-center text-sm font-bold shadow-[0_8px_24px_rgba(0,0,0,0.5)] ${x.ok ? "border-flame/40 text-flame" : "border-blood/50 text-blood"}`}
        >
          {x.text}
        </p>
      ))}
    </div>
  );
}
