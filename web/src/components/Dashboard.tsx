import { motion } from "motion/react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Valheim } from "../lib/useValheim";
import { useI18n } from "../i18n";
import { Atmosphere } from "./Atmosphere";
import { Chart } from "./Chart";
import { Chronicle } from "./Chronicle";
import { Forge } from "./Forge";
import { Header, OfflineBanner } from "./Header";
import { Hearth } from "./Hearth";
import { JoinCode } from "./JoinCode";
import { ServerPassword } from "./ServerPassword";
import { Plank } from "./Plank";
import { ProfileProvider } from "./PlayerName";
import { Ranking } from "./Ranking";
import { Runes } from "./Runes";
import { Saga } from "./Saga";
import { Treasury } from "./Treasury";
import { Progress, World } from "./World";
import { BOSSES } from "../lib/world";
import { cancelApply } from "../lib/api";

// Opened on demand; the chunk is preloaded as soon as a pointer reaches a player name.
const ProfileSheet = lazy(() => import("./ProfileSheet"));
const SettingsSheet = lazy(() => import("./SettingsSheet"));
const MapView = lazy(() => import("./map/MapView"));
const MapPreview = lazy(() => import("./map/MapPreview"));

const MAP_HASH = "#map";

/** The map is a place you can go Back from: it lives at #map. */
function useMapRoute(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(() => typeof location !== "undefined" && location.hash === MAP_HASH);
  useEffect(() => {
    const sync = () => setOpen(location.hash === MAP_HASH);
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  const show = useCallback(() => {
    if (location.hash !== MAP_HASH) history.pushState({ skaldMap: true }, "", MAP_HASH);
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    // Opened from here: Back pops it. Landed on #map directly: drop the hash in place.
    if ((history.state as { skaldMap?: boolean } | null)?.skaldMap && location.hash === MAP_HASH) history.back();
    else history.replaceState(null, "", location.pathname + location.search);
    setOpen(false);
  }, []);
  return [open, show, hide];
}

function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Dashboard({ live, onLogout }: { live: Valheim; onLogout: () => void }) {
  const { t, tn, dayLabel, clock, intl } = useI18n();
  const now = useNow();
  const { state, online, logs, lastAction } = live;
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
  const [mapOpen, openMap, closeMapRoute] = useMapRoute();
  const mapOpener = useRef<Element | null>(null);
  const showMap = useCallback(() => {
    mapOpener.current = document.activeElement;
    openMap();
  }, [openMap]);
  const closeMap = useCallback(() => {
    closeMapRoute();
    (mapOpener.current as HTMLElement | null)?.focus?.();
  }, [closeMapRoute]);

  const online7d = state?.history.online7d;
  const onlineChart = useMemo(
    () => ({
      series: [{ name: t("online.series"), points: online7d ?? [], color: "#f3b867" }],
      format: (v: number) => t("online.value", { n: Math.round(v) }),
      ticks: { every: 86_400_000, format: (v: number) => new Date(v).toLocaleDateString(intl, { weekday: "short" }) },
    }),
    [online7d, t, intl],
  );
  const onlineTime = useCallback((v: number) => `${dayLabel(new Date(v).toISOString(), now)}, ${clock(v)}`, [dayLabel, clock, now]);

  const serverName = state?.server.name;
  useEffect(() => {
    document.title = serverName ? `${serverName} - Skald` : "Skald";
  }, [serverName]);

  if (!state) {
    return (
      <main className="relative grid min-h-[100dvh] place-items-center">
        <Atmosphere dim />
        <p className="on-world relative z-10 text-lg font-bold uppercase tracking-[0.09em] text-flame">{t("app.loading")}</p>
      </main>
    );
  }

  const players = state.players;
  // A new save is a new map.
  const saveKey = state.world.meta?.savedAt ?? "";
  return (
    <ProfileProvider value={openProfile}>
      <div className="relative min-h-[100dvh]">
        <Atmosphere dim={!online} />
        {!online && <OfflineBanner />}
        <motion.main
          className="relative z-10 mx-auto max-w-[82.5rem] space-y-5 px-4 pb-28 pt-6 sm:px-6 lg:space-y-6 lg:pt-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8 }}
        >
          <Header
            server={state.server}
            online={online}
            now={now}
            onLogout={onLogout}
            settings={state.settings}
            onSettings={openSettings}
            onCancelArmed={cancelArmed}
            clock={state.world.clock}
            day={state.world.meta?.day}
            onMap={showMap}
          />

          <div className="grid gap-5 lg:grid-cols-12 lg:gap-6">
            {/* No board: the code sits straight on the world, like the game's centre-screen messages. */}
            <section className="relative flex flex-col items-center justify-center bg-[radial-gradient(55%_60%_at_50%_50%,rgba(70,104,112,0.13),transparent_72%)] px-4 py-8 sm:py-12 lg:col-span-8" aria-label={t("plank.joinCode")}>
              <JoinCode code={state.server.joinCode} codeAt={state.server.joinCodeAt} status={state.server.status} now={now} />
              {state.settings?.enabled && state.settings.passwordSet && <ServerPassword stamp={state.settings} />}
            </section>
            <Plank title={t("plank.hearth")} id="hearth" aside={tn("plank.hearth.aside", players.length)} className="lg:col-span-4">
              <Hearth players={players} now={now} />
            </Plank>
          </div>

          <div className="grid gap-5 lg:grid-cols-12 lg:gap-6">
            <Plank title={t("plank.world")} id="world" aside={state.world.meta?.name || state.server.world || undefined} className="lg:col-span-7">
              <World meta={state.world.meta} now={now} />
            </Plank>
            <Plank title={t("plank.progress")} id="progress" aside={t("plank.progress.aside")} className="lg:col-span-5">
              <Progress bosses={state.world.meta?.bosses ?? BOSSES} />
            </Plank>
          </div>

          <Plank title={t("map.title")} id="map" aside={t("map.preview.aside")}>
            <Suspense fallback={<div className="h-56 sm:h-64" />}>
              <MapPreview saveKey={saveKey} onOpen={showMap} />
            </Suspense>
          </Plank>

          <div className="grid gap-5 lg:grid-cols-12 lg:gap-6">
            <Plank title={t("plank.saga")} id="saga" aside={t("plank.saga.aside")} className="lg:col-span-7">
              <Saga events={state.history.events} now={now} />
            </Plank>
            <div className="space-y-5 lg:col-span-5 lg:space-y-6">
              <Plank title={t("plank.ranking")} id="ranking">
                <Ranking players={state.history.players} now={now} />
              </Plank>
              <Plank title={t("plank.online")} id="online" aside={t("plank.online.aside")}>
                <Chart
                  label={t("online.label")}
                  series={onlineChart.series}
                  step
                  height={110}
                  format={onlineChart.format}
                  timeFormat={onlineTime}
                  empty={t("online.empty")}
                  ticks={onlineChart.ticks}
                />
              </Plank>
            </div>
          </div>

          <Plank title={t("plank.forge")} id="forge" aside={state.metricsConfigured === false ? undefined : t("plank.forge.aside")}>
            <Forge metrics={state.metrics} metricsConfigured={state.metricsConfigured} server={state.server} world={state.world} now={now} />
          </Plank>

          <div className="grid gap-5 lg:grid-cols-12 lg:gap-6">
            <Plank title={t("plank.treasury")} id="treasury" aside={tn("plank.treasury.aside", state.backups.length)} className="lg:col-span-6">
              <Treasury backups={state.backups} now={now} />
            </Plank>
            <Plank title={t("plank.runes")} id="runes" className="lg:col-span-6">
              <Runes online={online} lastAction={lastAction} />
            </Plank>
          </div>

          <Plank title={t("plank.chronicle")} id="chronicle" aside={t("plank.chronicle.aside")}>
            <Chronicle source={logs} />
          </Plank>
          <p className="on-world pt-2 text-center text-xs text-ash">{t("footer.unofficial")}</p>
        </motion.main>
        {profile && (
          <Suspense fallback={null}>
            <ProfileSheet key={profile} name={profile} now={now} onClose={closeProfile} />
          </Suspense>
        )}
        {mapOpen && (
          <Suspense fallback={null}>
            <MapView seedName={state.world.meta?.seedName ?? ""} saveKey={saveKey} now={now} onClose={closeMap} />
          </Suspense>
        )}
        {settingsOpen && state.settings?.enabled && (
          <Suspense fallback={null}>
            <SettingsSheet summary={state.settings} effectiveName={state.server.name} worldModifiers={state.world.meta?.modifiers} focusFooter={settingsOpen === "footer"} onClose={closeSettings} />
          </Suspense>
        )}
      </div>
    </ProfileProvider>
  );
}
