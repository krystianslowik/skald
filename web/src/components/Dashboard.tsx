import { motion } from "motion/react";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Valheim } from "../lib/useValheim";
import { useI18n } from "../i18n";
import { Atmosphere } from "./Atmosphere";
import { Chart } from "./Chart";
import { Chronicle } from "./Chronicle";
import { Forge } from "./Forge";
import { Header, OfflineBanner } from "./Header";
import { Hearth } from "./Hearth";
import { JoinPanel } from "./JoinPanel";
import { Plank } from "./Plank";
import { Preferences } from "./Preferences";
import { TabBar } from "./TabBar";
import { ProfileProvider } from "./PlayerName";
import { Ranking } from "./Ranking";
import { Runes } from "./Runes";
import { Saga } from "./Saga";
import { Treasury } from "./Treasury";
import { VillageStores } from "./storage/VillageStores";
import type { MapFocus } from "./map/MapView";
import type { StoreEntry } from "../lib/storage";
import { Progress, World } from "./World";
import { BOSSES } from "../lib/world";
import { cancelApply, type LogoutResult } from "../lib/api";
import { PHONE, useMedia } from "../lib/useMedia";
import { TABS, useRoute, type Tab } from "../lib/useRoute";
import { AdminProvider } from "./admin/AdminContext";
import { AdminBoard } from "./admin/AdminBoard";
import { lazyChunk } from "../lib/chunks";
import { ChunkBoundary } from "./ErrorBoundary";

// Opened on demand; the chunk is preloaded as soon as a pointer reaches a player name.
const ProfileSheet = lazyChunk(() => import("./ProfileSheet"), "ProfileSheet");
const SettingsSheet = lazyChunk(() => import("./SettingsSheet"), "SettingsSheet");
const MapView = lazyChunk(() => import("./map/MapView"), "MapView");
const MapPreview = lazyChunk(() => import("./map/MapPreview"), "MapPreview");

export function Dashboard({ live, onLogout, onUnauthorized = () => void onLogout() }: { live: Valheim; onLogout: () => Promise<LogoutResult>; onUnauthorized?: () => void }) {
  const { t, tn, dayLabel, clock, intl } = useI18n();
  const { state, online, logs, lastAction, retry } = live;
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
  // null = closed; "top" from the header button, "footer" from the pending chip.
  const [settingsOpen, setSettingsOpen] = useState<null | "top" | "footer">(null);
  const settingsOpener = useRef<Element | null>(null);
  const openSettings = useCallback((footer: boolean) => {
    settingsOpener.current = document.activeElement;
    setSettingsOpen(footer ? "footer" : "top");
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(null);
    (settingsOpener.current as HTMLElement | null)?.focus?.();
  }, []);
  const cancelArmed = useCallback(() => void cancelApply().catch(() => undefined), []);
  // Phones: one tab at a time behind a bottom bar. Wider screens: every board, and #map as an overlay.
  const phone = useMedia(PHONE);
  const [tab, go] = useRoute();
  const mapOpen = tab === "map";
  const mapOpener = useRef<Element | null>(null);
  const showMap = useCallback(() => {
    mapOpener.current = document.activeElement;
    go("map");
  }, [go]);
  const closeMap = useCallback(() => {
    go("fire");
    (mapOpener.current as HTMLElement | null)?.focus?.({ preventScroll: true });
  }, [go]);
  // Where an item is kept, handed from the stores to the map; cleared when the map goes.
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
  const showStore = useCallback(
    (entry: StoreEntry, open: string) => {
      mapOpener.current = document.activeElement;
      setMapFocus({ ids: entry.places.map((p) => p.container.id), open, label: entry.label, key: Date.now() });
      go("map");
    },
    [go],
  );
  const clearFocus = useCallback(() => setMapFocus(null), []);
  useEffect(() => {
    if (!mapOpen) setMapFocus(null);
  }, [mapOpen]);
  const openServerSettings = useCallback(() => openSettings(false), [openSettings]);

  // Each tab keeps its own scroll position; the map sits over the fire's.
  const scrolls = useRef<Partial<Record<Tab, number>>>({});
  const shownTab: Tab = tab === "map" ? "fire" : tab;
  const lastShown = useRef(shownTab);
  useLayoutEffect(() => {
    if (!phone || lastShown.current === shownTab) return;
    scrolls.current[lastShown.current] = window.scrollY;
    lastShown.current = shownTab;
    window.scrollTo(0, scrolls.current[shownTab] ?? 0);
  }, [phone, shownTab]);

  const online7d = state?.history.online7d;
  const onlineChart = useMemo(
    () => ({
      series: [{ name: t("online.series"), points: online7d ?? [], color: "#f3b867" }],
      format: (v: number) => t("online.value", { n: Math.round(v) }),
      ticks: { every: 86_400_000, format: (v: number) => new Date(v).toLocaleDateString(intl, { weekday: "short" }) },
    }),
    [online7d, t, intl],
  );
  // Read when the chart asks (hover), so the dashboard needs no clock of its own.
  const onlineTime = useCallback((v: number) => `${dayLabel(new Date(v).toISOString())}, ${clock(v)}`, [dayLabel, clock]);

  const serverName = state?.server.name;
  useEffect(() => {
    document.title = serverName ? `${serverName} - Skald` : "Skald";
  }, [serverName]);

  if (!state) return <Booting online={online} onRetry={retry} />;

  const players = state.players;
  // A new save is a new map.
  const saveKey = state.world.meta?.savedAt ?? "";
  const header = (
    <Header
      server={state.server}
      online={online}
      onLogout={onLogout}
      settings={state.settings}
      onSettings={openSettings}
      onCancelArmed={cancelArmed}
      clock={state.world.clock}
      day={state.world.meta?.day}
      onMap={showMap}
      compact={phone}
    />
  );
  // No board: the code sits straight on the world, like the game's centre-screen messages.
  const join = (
    <section className="relative flex flex-col items-center justify-center bg-[radial-gradient(55%_60%_at_50%_50%,rgba(70,104,112,0.13),transparent_72%)] px-4 py-8 sm:py-12 lg:col-span-7 lg:py-6" aria-label={t("plank.joinCode")}>
      <JoinPanel
        code={state.server.joinCode}
        codeAt={state.server.joinCodeAt}
        status={state.server.status}
        serverName={state.server.name}
        hasPassword={!!(state.settings?.enabled && state.settings.passwordSet)}
        stamp={state.settings}
        sticky={phone && shownTab === "fire" && !mapOpen}
      />
    </section>
  );
  const hearth = (
    <Plank title={t("plank.hearth")} id="hearth" aside={tn("plank.hearth.aside", players.length)} className="lg:col-span-5">
      <Hearth players={players} />
    </Plank>
  );
  const world = (
    <Plank title={t("plank.world")} id="world" aside={state.world.meta?.name || state.server.world || undefined} className="lg:col-span-7">
      <World meta={state.world.meta} />
    </Plank>
  );
  const progress = (
    <Plank title={t("plank.progress")} id="progress" aside={t("plank.progress.aside")} className="lg:col-span-5">
      <Progress bosses={state.world.meta?.bosses ?? BOSSES} />
    </Plank>
  );
  const mapBoard = (
    <Plank title={t("map.title")} id="map" aside={t("map.preview.aside")}>
      <ChunkBoundary>
        <Suspense fallback={<div className="h-56 sm:h-64" />}>
          <MapPreview saveKey={saveKey} onOpen={showMap} />
        </Suspense>
      </ChunkBoundary>
    </Plank>
  );
  const stores = (
    <Plank title={t("store.title")} id="stores" aside={t("store.aside")}>
      <VillageStores saveKey={saveKey} onShow={showStore} />
    </Plank>
  );
  const saga = (
    <Plank title={t("plank.saga")} id="saga" aside={t("plank.saga.aside")} className="lg:col-span-7">
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
  const forge = (
    <Plank title={t("plank.forge")} id="forge" aside={state.metricsConfigured === false ? undefined : t("plank.forge.aside")}>
      <Forge metrics={state.metrics} metricsConfigured={state.metricsConfigured} server={state.server} world={state.world} />
    </Plank>
  );
  const treasury = (
    <Plank title={t("plank.treasury")} id="treasury" aside={tn("plank.treasury.aside", state.backups.length)} className="lg:col-span-7">
      <Treasury backups={state.backups} />
    </Plank>
  );
  const runes = (
    <Plank title={t("plank.runes")} id="runes" className="lg:col-span-5 lg:flex lg:flex-col">
      <Runes online={online} lastAction={lastAction} />
    </Plank>
  );
  const chronicle = (
    <Plank title={t("plank.chronicle")} id="chronicle" aside={t("plank.chronicle.aside")}>
      <Chronicle source={logs} />
    </Plank>
  );
  const footer = <p className="on-world pt-2 text-center text-xs text-ash">{t("footer.unofficial")}</p>;

  return (
    <AdminProvider state={state} online={online} onUnauthorized={onUnauthorized} onShowMap={showMap}>
    <ProfileProvider value={openProfile}>
      <div className="relative min-h-dvh">
        <Atmosphere dim={!online} paused={mapOpen} />
        {!online && <OfflineBanner />}
        {phone ? (
          <main className="relative z-10 mx-auto max-w-xl pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(var(--tabbar-h)+1.5rem)] pt-[max(1.25rem,env(safe-area-inset-top))]">
            {/* Each tab fades in on its own; the boards inside do not move. */}
            <motion.div key={shownTab} className="space-y-5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
              {shownTab === "fire" && (
                <>
                  {header}
                  {join}
                  {hearth}
                  {world}
                  {progress}
                  {mapBoard}
                </>
              )}
              {shownTab === "saga" && (
                <>
                  {stores}
                  {saga}
                  {ranking}
                  {onlineBoard}
                </>
              )}
              {shownTab === "settings" && (
                <>
                  <AdminBoard />
                  <Preferences onServerSettings={state.settings?.enabled ? openServerSettings : undefined} onLogout={onLogout} webVersion={state.webVersion} agentVersion={state.agent.version} />
                  {runes}
                  {forge}
                  {treasury}
                  {chronicle}
                  {footer}
                </>
              )}
            </motion.div>
          </main>
        ) : (
          <motion.main
            className="relative z-10 mx-auto max-w-330 space-y-5 px-4 pb-28 pt-6 sm:px-6 lg:space-y-6 lg:pt-10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8 }}
          >
            {header}
            {/* The code and who is at the fire side by side, centred on each other: the board as tall as its players. */}
            <div className="grid gap-5 lg:grid-cols-12 lg:items-center lg:gap-6">
              {join}
              {hearth}
            </div>
            <div className="grid gap-5 lg:grid-cols-12 lg:gap-6">
              {world}
              {progress}
            </div>
            {mapBoard}
            {stores}
            <div className="grid gap-5 lg:grid-cols-12 lg:gap-6">
              {saga}
              <div className="space-y-5 lg:col-span-5 lg:space-y-6">
                {ranking}
                {onlineBoard}
              </div>
            </div>
            {forge}
            <div className="grid gap-5 lg:grid-cols-12 lg:gap-6">
              {treasury}
              {runes}
            </div>
            {chronicle}
            {footer}
          </motion.main>
        )}
        {phone && <TabBar tab={tab} tabs={TABS} onTab={go} />}
        {profile && (
          <ChunkBoundary overlay onClose={closeProfile}>
            <Suspense fallback={null}>
              <ProfileSheet key={profile} name={profile} onClose={closeProfile} />
            </Suspense>
          </ChunkBoundary>
        )}
        {mapOpen && (
          <ChunkBoundary overlay onClose={closeMap}>
            <Suspense fallback={null}>
              <MapView seedName={state.world.meta?.seedName ?? ""} saveKey={saveKey} onClose={closeMap} asTab={phone} focus={mapFocus} onFocusClear={clearFocus} />
            </Suspense>
          </ChunkBoundary>
        )}
        {settingsOpen && state.settings?.enabled && (
          <ChunkBoundary overlay onClose={closeSettings}>
            <Suspense fallback={null}>
              <SettingsSheet summary={state.settings} effectiveName={state.server.name} worldModifiers={state.world.meta?.modifiers} focusFooter={settingsOpen === "footer"} onClose={closeSettings} />
            </Suspense>
          </ChunkBoundary>
        )}
      </div>
    </ProfileProvider>
    </AdminProvider>
  );
}

/** A first state this late with the link down is an outage, not a slow load. */
export const BOOT_GRACE_MS = 3000;

/**
 * Before the first state: the loading line, and once a few seconds passed with
 * no link to the server (offline, skald-web down) a note saying so, with a
 * button to try at once instead of waiting out the reconnect backoff.
 */
function Booting({ online, onRetry }: { online: boolean; onRetry?: () => void }) {
  const { t } = useI18n();
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), BOOT_GRACE_MS);
    return () => clearTimeout(timer);
  }, []);
  const down = late && !online;
  return (
    <main className="relative grid min-h-dvh place-items-center px-4">
      <Atmosphere dim />
      <div className="relative z-10 text-center">
        <p className="on-world text-lg font-bold uppercase tracking-[0.09em] text-flame">{t("app.loading")}</p>
        {down && (
          <div role="status" className="plank mx-auto mt-6 max-w-sm px-5 py-5">
            <p className="plank-title text-base">{t("offline.title")}</p>
            <p className="mt-2 text-sm text-bone/90">{t("app.unreachable")}</p>
            {onRetry && (
              <button type="button" onClick={onRetry} className="plaque press mt-4 w-full py-2.5 text-lg font-bold text-flame! hover:text-gold!">
                {t("app.retry")}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
