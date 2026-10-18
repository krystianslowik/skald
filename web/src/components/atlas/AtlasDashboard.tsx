import { motion } from "motion/react";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Valheim } from "../../lib/useValheim";
import type { ApiState, Player } from "../../types";
import { useI18n, type I18n, type TextKey } from "../../i18n";
import { Atmosphere } from "../Atmosphere";
import { Chart } from "../Chart";
import { Chronicle } from "../Chronicle";
import { Forge } from "../Forge";
import { flameLevel, OfflineBanner, preloadMap } from "../Header";
import { Flame } from "../Flame";
import { Hearth } from "../Hearth";
import { JoinPanel } from "../JoinPanel";
import { Plank } from "../Plank";
import { Preferences } from "../Preferences";
import { ICONS, LABELS, TabBar } from "../TabBar";
import { ProfileProvider } from "../PlayerName";
import { Ranking } from "../Ranking";
import { Runes } from "../Runes";
import { Saga } from "../Saga";
import { Treasury } from "../Treasury";
import { VillageStores } from "../storage/VillageStores";
import type { MapFocus } from "../map/MapView";
import type { StoreEntry } from "../../lib/storage";
import { Progress, World } from "../World";
import { WorldClock } from "../WorldClock";
import { Elapsed, RelativeTime } from "../RelativeTime";
import { SkaldVersion } from "../SkaldVersion";
import { preloadSettingsSheet, SettingsGlyph } from "../SettingsGlyph";
import { BOSSES } from "../../lib/world";
import { gameVersion } from "../../lib/format";
import { cancelApply, type LogoutResult } from "../../lib/api";
import { PHONE, useMedia } from "../../lib/useMedia";
import { TABS, useRoute, type Tab } from "../../lib/useRoute";
import { AdminProvider, preloadAdmin, useAdmin } from "../admin/AdminContext";
import { AdminBoard } from "../admin/AdminBoard";
import { AdminGlyph } from "../admin/glyphs";
import { CompatNotice } from "../Compat";
import { lazyChunk } from "../../lib/chunks";
import { ChunkBoundary } from "../ErrorBoundary";
// One lazy call site per chunk (chunks.test): the default layout's.
import { MapView, ProfileSheet, SettingsSheet } from "../Dashboard";

const AtlasMap = lazyChunk(() => import("./AtlasMap"), "AtlasMap");

/**
 * The Atlas tab model on the same four hash slots the default layout uses, so
 * Back and deep links behave the same: `#settings` is the Server tab here.
 */
const ATLAS_LABELS: Record<Tab, TextKey> = { ...LABELS, settings: "atlas.tab.server" };
const SERVER_PATH = "M4 5h16v5H4zM4 14h16v5H4zM7.5 7.5h.01M7.5 16.5h.01M11 7.5h5M11 16.5h5";
const ATLAS_ICONS: Record<Tab, string> = { ...ICONS, settings: SERVER_PATH };
/** Remembered apart from the default layout's switch, and off until the admin turns it on. */
const ATLAS_INCLUDE_KEY = "skald.atlas.share.password";

// ---- prototype-only demo states -------------------------------------------
// `?demo=empty|crowd|newworld` reshapes the live state so the screens the mock
// cannot hold still (nobody on, a full fire, a fresh save) can be looked at.
type Demo = "empty" | "crowd" | "newworld" | null;
const demo: Demo = (() => {
  const d = new URLSearchParams(globalThis.location?.search ?? "").get("demo");
  return d === "empty" || d === "crowd" || d === "newworld" ? d : null;
})();
const CROWD = ["Ragnar", "Freya", "Bjorn", "Astrid", "Sigrid", "Leif", "Ingrid", "Halvar"];
function withDemo(state: ApiState): ApiState {
  if (!demo) return state;
  if (demo === "crowd") {
    const now = Date.parse(state.now);
    const players: Player[] = CROWD.map((name, i) => state.players.find((p) => p.name === name) ?? { name, since: new Date(now - (95 - i * 11) * 60_000).toISOString(), platform: i % 2 ? "steam" : "xbox" });
    return { ...state, players };
  }
  const empty = { ...state, players: [] };
  if (demo === "empty") return empty;
  const meta = state.world.meta;
  return {
    ...empty,
    history: { ...state.history, events: state.history.events.filter((e) => e.type !== "death" && e.type !== "raid").slice(-6) },
    world: {
      ...state.world,
      clock: state.world.clock ? { ...state.world.clock, day: 2 } : state.world.clock,
      meta: meta ? { ...meta, day: 2, bosses: meta.bosses?.map((b) => ({ ...b, defeated: false })) } : meta,
    },
  };
}

/** "Ragnar", "Ragnar and Freya", "Ragnar, Freya and Bjorn", then "Ragnar, Freya and 6 others". */
export function welcome(i: I18n, players: readonly { name: string }[]): string {
  const n = players.map((p) => p.name);
  if (n.length === 0) return i.t("atlas.welcome.empty");
  const names =
    n.length === 1
      ? n[0]!
      : n.length === 2
        ? i.t("atlas.and", { a: n[0]!, b: n[1]! })
        : n.length === 3
          ? i.t("atlas.and", { a: `${n[0]}, ${n[1]}`, b: n[2]! })
          : i.tn("atlas.welcome.others", n.length - 2, { names: `${n[0]}, ${n[1]}` });
  return i.t("atlas.welcome", { names });
}

export default function AtlasDashboard({ live, onLogout, onUnauthorized = () => {} }: { live: Valheim; onLogout: () => Promise<LogoutResult>; onUnauthorized?: () => void }) {
  const i18n = useI18n();
  const { t, tn, dayLabel, clock, intl } = i18n;
  const { online, logs, lastAction } = live;
  const state = useMemo(() => (live.state ? withDemo(live.state) : null), [live.state]);
  const [profile, setProfile] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openProfile = useCallback((name: string, el: HTMLElement) => {
    opener.current = el;
    setProfile(name);
  }, []);
  const closeProfile = useCallback(() => {
    setProfile(null);
    opener.current?.focus();
  }, []);
  const [settingsOpen, setSettingsOpen] = useState<null | "top" | "footer">(null);
  const openSettings = useCallback((footer: boolean) => setSettingsOpen(footer ? "footer" : "top"), []);
  const closeSettings = useCallback(() => setSettingsOpen(null), []);
  const cancelArmed = useCallback(() => void cancelApply().catch(() => undefined), []);

  const phone = useMedia(PHONE);
  const [tab, go] = useRoute();
  // Phones: the Map tab shows either the map or the stores; the stores' "show on map" flips it back.
  const [mapSide, setMapSide] = useState<"map" | "stores">("map");
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
  const showMap = useCallback(() => {
    setMapSide("map");
    go("map");
  }, [go]);
  const showStore = useCallback(
    (entry: StoreEntry, open: string) => {
      setMapFocus({ ids: entry.places.map((p) => p.container.id), open, label: entry.label, key: Date.now() });
      setMapSide("map");
      go("map");
    },
    [go],
  );
  const clearFocus = useCallback(() => setMapFocus(null), []);
  useEffect(() => {
    if (tab !== "map") setMapFocus(null);
  }, [tab]);

  // Each tab keeps its own scroll position.
  const scrolls = useRef<Partial<Record<Tab, number>>>({});
  const lastTab = useRef(tab);
  useLayoutEffect(() => {
    if (lastTab.current === tab) return;
    scrolls.current[lastTab.current] = window.scrollY;
    lastTab.current = tab;
    window.scrollTo(0, scrolls.current[tab] ?? 0);
  }, [tab]);

  const online7d = state?.history.online7d;
  const onlineChart = useMemo(
    () => ({
      series: [{ name: t("online.series"), points: online7d ?? [], color: "#f3b867" }],
      format: (v: number) => t("online.value", { n: Math.round(v) }),
      ticks: { every: 86_400_000, format: (v: number) => new Date(v).toLocaleDateString(intl, { weekday: "short" }) },
    }),
    [online7d, t, intl],
  );
  const onlineTime = useCallback((v: number) => `${dayLabel(new Date(v).toISOString())}, ${clock(v)}`, [dayLabel, clock]);

  const serverName = state?.server.name;
  useEffect(() => {
    document.title = serverName ? `${serverName} - Skald` : "Skald";
  }, [serverName]);

  if (!state) return <main className="relative grid min-h-dvh place-items-center"><Atmosphere dim /><p className="on-world relative z-10 text-lg font-bold uppercase tracking-[0.09em] text-flame">{t("app.loading")}</p></main>;

  const s = state.server;
  const players = state.players;
  const meta = state.world.meta;
  const saveKey = meta?.savedAt ?? "";
  const level = flameLevel(s, online);
  const since = s.serverStartedAt && s.status === "running" ? s.serverStartedAt : null;
  const settingsOn = !!state.settings?.enabled;

  // ---- boards ---------------------------------------------------------------
  const join = (
    <Plank title={t("atlas.join")} id="atlas-join" className={phone ? "" : "lg:flex-none"}>
      <JoinPanel
        code={s.joinCode}
        codeAt={s.joinCodeAt}
        status={s.status}
        serverName={s.name}
        hasPassword={!!(state.settings?.enabled && state.settings.passwordSet)}
        stamp={state.settings}
        sticky={phone && tab === "fire"}
        compact
        includeKey={ATLAS_INCLUDE_KEY}
        includeDefault={false}
      />
    </Plank>
  );
  const hearth = (
    <Plank title={t("plank.hearth")} id="hearth" aside={tn("plank.hearth.aside", players.length)} className="flex flex-col lg:flex-1">
      <div className="flex flex-1 items-center justify-center">
        <Hearth players={players} />
      </div>
    </Plank>
  );
  const facts = (
    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-iron/30 pt-3 text-sm sm:grid-cols-4">
      <WorldClock clock={state.world.clock} day={meta?.day} />
      <div>
        <dt className="text-xs text-ash">{t("header.burning")}</dt>
        <dd className="whitespace-nowrap font-bold text-bone">{since ? <Elapsed since={since} /> : t("header.notBurning")}</dd>
      </div>
      <div>
        <dt className="text-xs text-ash">{t("world.savedOnDisk")}</dt>
        <dd className="font-bold text-bone"><RelativeTime iso={meta?.savedAt ?? state.world.lastSaveAt} /></dd>
      </div>
      <GameVersion version={s.version} />
    </dl>
  );
  const mapBoard = (
    <Plank title={t("map.title")} id="atlas-map" aside={t("map.preview.aside")} className="flex flex-col">
      <ChunkBoundary>
        <Suspense fallback={<div className={phone ? "h-52" : "min-h-80 flex-1"} />}>
          <AtlasMap saveKey={saveKey} onOpen={showMap} fresh={demo === "newworld"} className={phone ? "h-60" : "min-h-80 flex-1"} />
        </Suspense>
      </ChunkBoundary>
      {facts}
    </Plank>
  );
  const recent = (
    <Plank title={t("atlas.recent")} id="atlas-recent" className="flex flex-col">
      <div className="max-h-72 overflow-hidden">
        <Saga events={state.history.events.slice(-30)} online={players} />
      </div>
      <div className="mt-3">
        <button type="button" onClick={() => go("saga")} className="plaque press min-h-11 px-4 text-sm font-bold">
          {t("atlas.recent.all")}
        </button>
      </div>
    </Plank>
  );
  const progress = (
    <Plank title={t("plank.progress")} id="progress" aside={t("plank.progress.aside")}>
      <Progress bosses={meta?.bosses ?? BOSSES} />
    </Plank>
  );
  const stores = (
    <Plank title={t("store.title")} id="stores" aside={t("store.aside")}>
      <VillageStores saveKey={saveKey} onShow={showStore} />
    </Plank>
  );
  const world = (
    <Plank title={t("atlas.map.world")} id="world" aside={meta?.name || s.world || undefined}>
      <World meta={meta} />
    </Plank>
  );
  const saga = (
    <Plank title={t("plank.saga")} id="saga" aside={t("plank.saga.aside")}>
      <Saga events={state.history.events} online={players} />
    </Plank>
  );
  const ranking = (
    <Plank title={t("plank.ranking")} id="ranking">
      <Ranking players={state.history.players} />
    </Plank>
  );
  const onlineBoard = (
    <Plank title={t("plank.online")} id="online" aside={t("plank.online.aside")}>
      <Chart label={t("online.label")} series={onlineChart.series} step height={110} format={onlineChart.format} timeFormat={onlineTime} empty={t("online.empty")} ticks={onlineChart.ticks} />
    </Plank>
  );
  const serverStatus = (
    <Plank title={t("atlas.server.status")} id="atlas-status">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div className="col-span-2">
          <dt className="text-xs text-ash">{t("atlas.tab.server")}</dt>
          <dd className="font-bold">
            <span className={level === "alive" ? "text-flame" : level === "ash" ? "text-ash" : "text-ember"}>{t(`flame.${level}`)}</span>
            <span className="text-bone">, {online ? t(STATUS[s.status] ?? "status.unknown") : t("header.noLink")}</span>
          </dd>
        </div>
        <GameVersion version={s.version} />
        <div>
          <dt className="text-xs text-ash">{t("header.burning")}</dt>
          <dd className="whitespace-nowrap font-bold text-bone">{since ? <Elapsed since={since} /> : t("header.notBurning")}</dd>
        </div>
      </dl>
      {settingsOn && (
        <button type="button" onClick={() => openSettings(false)} onPointerEnter={preloadSettingsSheet} onFocus={preloadSettingsSheet} aria-haspopup="dialog" className="plaque press mt-4 flex min-h-12 w-full items-center gap-3 px-4 text-left font-bold">
          <SettingsGlyph size={20} className="text-current" />
          <span className="flex-1">{t("settings.open")}</span>
          <Chevron />
        </button>
      )}
    </Plank>
  );
  const forge = (
    <Plank title={t("plank.forge")} id="forge" aside={state.metricsConfigured === false ? undefined : t("plank.forge.aside")}>
      <Forge metrics={state.metrics} metricsConfigured={state.metricsConfigured} server={state.server} world={state.world} />
    </Plank>
  );
  const treasury = (
    <Plank title={t("plank.treasury")} id="treasury" aside={tn("plank.treasury.aside", state.backups.length)}>
      <Treasury backups={state.backups} />
    </Plank>
  );
  const runes = (
    <Plank title={t("plank.runes")} id="runes" className="lg:flex lg:flex-col">
      <Runes online={online} lastAction={lastAction} />
    </Plank>
  );
  const chronicle = (
    <Plank title={t("plank.chronicle")} id="chronicle" aside={t("plank.chronicle.aside")}>
      <Chronicle source={logs} />
    </Plank>
  );
  const footer = (
    <footer className="on-world space-y-1 pt-2 text-center text-xs text-ash">
      <p>{t("footer.unofficial")}</p>
      {state.webVersion && <SkaldVersion web={state.webVersion} agent={state.agent.version} />}
    </footer>
  );

  const header = (
    <AtlasHeader
      state={state}
      online={online}
      level={level}
      phone={phone}
      tab={tab}
      onTab={go}
      onSettings={settingsOn ? openSettings : undefined}
      onCancelArmed={cancelArmed}
      menu={<Preferences onLogout={onLogout} webVersion={state.webVersion} agentVersion={state.agent.version} />}
      welcomeLine={welcome(i18n, players)}
    />
  );

  // ---- tabs -----------------------------------------------------------------
  let body: ReactNode;
  if (tab === "fire") {
    body = phone ? (
      <>
        {join}
        {hearth}
        {mapBoard}
        {recent}
        {progress}
      </>
    ) : (
      <>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-stretch lg:gap-6" data-testid="atlas-hero">
          {mapBoard}
          <div className="flex min-w-0 flex-col gap-5 lg:gap-6">
            {join}
            {hearth}
          </div>
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-6">
          {recent}
          {progress}
        </div>
      </>
    );
  } else if (tab === "map") {
    const map = (
      <ChunkBoundary>
        <Suspense fallback={null}>
          <MapView saveKey={saveKey} onClose={() => go("fire")} embedded focus={mapFocus} onFocusClear={clearFocus} />
        </Suspense>
      </ChunkBoundary>
    );
    body = phone ? (
      <>
        <div className="flex gap-2" role="group" aria-label={t("tab.map")}>
          <button type="button" aria-pressed={mapSide === "map"} onClick={() => setMapSide("map")} className="plaque press min-h-11 flex-1 px-3 text-sm font-bold">
            {t("tab.map")}
          </button>
          <button type="button" aria-pressed={mapSide === "stores"} onClick={() => setMapSide("stores")} className="plaque press min-h-11 flex-1 px-3 text-sm font-bold">
            {t("store.title")}
          </button>
        </div>
        {mapSide === "map" ? (
          <div className="-mx-4 h-[calc(100dvh-var(--tabbar-h)-11.5rem)] min-h-80">{map}</div>
        ) : (
          <>
            {stores}
            {world}
          </>
        )}
      </>
    ) : (
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-6">
        <div className="plank h-[calc(100dvh-14rem)] min-h-[32rem] p-2">{map}</div>
        <div className="space-y-5 lg:space-y-6">
          {stores}
          {world}
        </div>
      </div>
    );
  } else if (tab === "saga") {
    body = phone ? (
      <>
        {saga}
        {ranking}
        {onlineBoard}
      </>
    ) : (
      <div className="grid gap-5 lg:grid-cols-12 lg:gap-6">
        <div className="lg:col-span-7">{saga}</div>
        <div className="space-y-5 lg:col-span-5 lg:space-y-6">
          {ranking}
          {onlineBoard}
        </div>
      </div>
    );
  } else {
    body = phone ? (
      <>
        {serverStatus}
        <AdminEntry />
        {runes}
        {forge}
        {treasury}
        {chronicle}
      </>
    ) : (
      <>
        <div className="grid gap-5 lg:grid-cols-12 lg:gap-6">
          <div className="lg:col-span-5">{serverStatus}</div>
          <div className="lg:col-span-7">
            <AdminEntry />
          </div>
        </div>
        {forge}
        <div className="grid gap-5 lg:grid-cols-12 lg:gap-6">
          <div className="lg:col-span-7">{treasury}</div>
          <div className="lg:col-span-5">{runes}</div>
        </div>
        {chronicle}
      </>
    );
  }

  return (
    <AdminProvider state={state} online={online} onUnauthorized={onUnauthorized} onShowMap={showMap}>
      <ProfileProvider value={openProfile}>
        <div className="relative min-h-dvh" data-layout="atlas" data-tab={tab}>
          <Atmosphere dim={!online} paused={tab === "map"} />
          {!online && <OfflineBanner />}
          <main
            className={
              phone
                ? "relative z-10 mx-auto max-w-xl space-y-5 pb-[calc(var(--tabbar-h)+1.5rem)] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))]"
                : "relative z-10 mx-auto max-w-330 space-y-5 px-4 pb-16 pt-6 sm:px-6 lg:space-y-6 lg:pt-8"
            }
          >
            {header}
            <AtlasCompatNotice />
            <motion.div key={tab} className="space-y-5 lg:space-y-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
              {body}
            </motion.div>
            {tab !== "map" && footer}
          </main>
          {phone && <TabBar tab={tab} tabs={TABS} onTab={go} labels={ATLAS_LABELS} icons={ATLAS_ICONS} />}
          {profile && (
            <ChunkBoundary overlay onClose={closeProfile}>
              <Suspense fallback={null}>
                <ProfileSheet key={profile} name={profile} onClose={closeProfile} />
              </Suspense>
            </ChunkBoundary>
          )}
          {settingsOpen && settingsOn && (
            <ChunkBoundary overlay onClose={closeSettings}>
              <Suspense fallback={null}>
                <SettingsSheet summary={state.settings!} effectiveName={s.name} worldModifiers={meta?.modifiers} focusFooter={settingsOpen === "footer"} onClose={closeSettings} />
              </Suspense>
            </ChunkBoundary>
          )}
        </div>
      </ProfileProvider>
    </AdminProvider>
  );
}

const STATUS: Record<string, TextKey> = {
  starting: "status.starting",
  running: "status.running",
  stopping: "status.stopping",
  stopped: "status.stopped",
  unknown: "status.unknown",
};

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

/** The game build, flagged when the admin bridge has not been tested against it. */
function GameVersion({ version }: { version: string | null | undefined }) {
  const { t } = useI18n();
  const untested = useAdmin()?.blocker === "untested";
  return (
    <div>
      <dt className="text-xs text-ash">{t("atlas.game")}</dt>
      <dd className="font-bold text-bone">
        {gameVersion(version)}
        {untested && <span className="block text-xs font-normal text-gold">{t("atlas.game.untested")}</span>}
      </dd>
    </div>
  );
}

/** Only news for whoever can act on it: a view-only session gets no compatibility notice. */
function AtlasCompatNotice() {
  const admin = useAdmin();
  if (admin?.present && !admin.unlocked) return null;
  return <CompatNotice view={admin?.compat} onDetails={admin?.present ? () => admin.open({ kind: "panel", section: "compat" }) : undefined} />;
}

/** The Server tab's way in: unlock for a view-only session, the admin board once unlocked. */
function AdminEntry() {
  const { t } = useI18n();
  const admin = useAdmin();
  if (!admin?.present) return null;
  if (!admin.unlocked)
    return (
      <Plank title={t("atlas.server.adminTitle")} id="atlas-admin" aside={t("admin.you.locked")}>
        <p className="text-sm text-bone/90">{t("atlas.server.viewerBody")}</p>
        <button type="button" onClick={() => void admin.unlock()} onPointerEnter={preloadAdmin} className="plaque press mt-4 flex min-h-12 w-full items-center gap-3 px-4 text-left font-bold text-flame!">
          <LockGlyph />
          <span className="flex-1">{t("atlas.unlock")}</span>
          <Chevron />
        </button>
      </Plank>
    );
  return <AdminBoard />;
}

function LockGlyph({ open = false }: { open?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="9" width="12" height="8.5" rx="1" />
      <path d={open ? "M7 9V6.5a3 3 0 0 1 5.8-1" : "M7 9V6.5a3 3 0 0 1 6 0V9"} />
    </svg>
  );
}

const NAV: readonly Tab[] = TABS;

/**
 * Name, status and the four places; on the right who you are here (view only
 * or admin) and the menu with this browser's preferences.
 */
function AtlasHeader({
  state,
  online,
  level,
  phone,
  tab,
  onTab,
  onSettings,
  onCancelArmed,
  menu,
  welcomeLine,
}: {
  state: ApiState;
  online: boolean;
  level: ReturnType<typeof flameLevel>;
  phone: boolean;
  tab: Tab;
  onTab: (t: Tab) => void;
  onSettings?: (footer: boolean) => void;
  onCancelArmed: () => void;
  menu: ReactNode;
  welcomeLine: string;
}) {
  const { t } = useI18n();
  const s = state.server;
  const settings = state.settings;
  const chips = settings?.enabled && (settings.pending || settings.armed) && onSettings;
  return (
    <header className="space-y-4">
      <div className="flex items-center gap-3 lg:gap-6">
        <div className="flex min-w-0 flex-1 items-center gap-3 lg:flex-none">
          <Flame level={level} size={phone ? 34 : 42} className="shrink-0 drop-shadow-[0_0_14px_rgba(214,96,24,0.45)]" />
          <div className="min-w-0">
            <h1 className={`on-world truncate font-bold uppercase tracking-[0.08em] text-flame ${phone ? "text-xl leading-tight" : "text-2xl"}`}>{s.name || "Valheim"}</h1>
            <p className="on-world truncate text-sm">
              <span className={level === "alive" ? "text-flame" : level === "ash" ? "text-ash" : "text-ember"}>{t(`flame.${level}`)}</span>
              <span className="text-ash">, {online ? t(STATUS[s.status] ?? "status.unknown") : t("header.noLink")}</span>
            </p>
          </div>
        </div>
        {!phone && (
          <nav aria-label={t("tabs.label")} className="mx-auto flex flex-wrap gap-2">
            {NAV.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={tab === id}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => onTab(id)}
                onPointerEnter={id === "map" ? preloadMap : undefined}
                className="plaque press flex min-h-11 items-center gap-2 px-3.5 text-sm font-bold"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={ATLAS_ICONS[id]} />
                </svg>
                {t(ATLAS_LABELS[id])}
              </button>
            ))}
          </nav>
        )}
        <div className="flex shrink-0 items-center gap-2">
          <RoleButton compact={phone} />
          <Menu compact={phone}>{menu}</Menu>
        </div>
      </div>
      {chips && <SettingsChipsRow armed={settings!.armed} onOpen={() => onSettings!(true)} onCancel={onCancelArmed} />}
      {tab === "fire" && <p className="on-world text-base font-bold text-bone lg:text-lg">{welcomeLine}</p>}
    </header>
  );
}

/** Saved settings waiting for a restart: the same chip the default header shows. */
function SettingsChipsRow({ armed, onOpen, onCancel }: { armed: boolean; onOpen: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={onOpen} className={`press min-h-11 rounded-[2px] border px-3 text-xs font-bold uppercase tracking-[0.06em] ${armed ? "border-white/25 bg-[linear-gradient(180deg,#7aaedc,#5e97cc_60%,#4c82b5)] text-[#10161d]" : "border-ember/60 bg-black/30 text-flame"}`}>
        {armed ? t("settings.armedChip") : t("settings.pendingChip")}
      </button>
      {armed && (
        <button type="button" onClick={onCancel} aria-label={t("settings.cancelArmed")} className="plaque press grid h-11 w-11 place-items-center">
          <svg width="12" height="12" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** View only: a way to unlock. Unlocked (or no admin password): the admin sheet. */
function RoleButton({ compact }: { compact: boolean }) {
  const { t } = useI18n();
  const admin = useAdmin();
  if (!admin?.present) return null;
  const locked = !admin.unlocked;
  const label = locked ? t("atlas.unlock") : t("admin.open");
  return (
    <button
      type="button"
      onClick={() => (locked ? void admin.unlock() : admin.open({ kind: "panel" }))}
      onPointerEnter={preloadAdmin}
      onFocus={preloadAdmin}
      aria-haspopup="dialog"
      aria-label={compact ? label : undefined}
      title={label}
      className={`plaque press relative flex min-h-11 min-w-11 items-center justify-center gap-2 text-sm font-bold ${compact ? "px-2.5" : "px-3.5"} ${locked ? "" : "text-flame!"}`}
    >
      {locked ? <LockGlyph /> : <AdminGlyph size={18} />}
      {!compact && <span>{label}</span>}
      {!locked && admin.bridgeOn && admin.blocker && <span aria-hidden className="absolute right-1 top-1 h-2 w-2 rounded-full bg-ember" />}
    </button>
  );
}

/** The header menu: this browser's preferences (language, sound, embers) and logging out. */
function Menu({ compact, children }: { compact: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="atlas-menu"
        aria-label={compact ? t("atlas.menu") : undefined}
        onClick={() => setOpen(!open)}
        className={`plaque press flex min-h-11 min-w-11 items-center justify-center gap-2 text-sm font-bold ${compact ? "px-2.5" : "px-3.5"}`}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
          <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />
        </svg>
        {!compact && <span>{t("atlas.menu")}</span>}
      </button>
      {open && (
        <div id="atlas-menu" className="absolute right-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] shadow-[0_18px_40px_rgba(0,0,0,0.6)]">
          {children}
        </div>
      )}
    </div>
  );
}
