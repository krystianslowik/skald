import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Valheim } from "../lib/useValheim";
import { useI18n } from "../i18n";
import { Atmosphere } from "./Atmosphere";
import { Chart } from "./Chart";
import { Chronicle } from "./Chronicle";
import { Forge } from "./Forge";
import { Header, OfflineBanner } from "./Header";
import { Hearth } from "./Hearth";
import { JoinCode } from "./JoinCode";
import { Plank } from "./Plank";
import { ProfileProvider, ProfileSheet } from "./Profile";
import { Ranking } from "./Ranking";
import { Runes } from "./Runes";
import { Saga } from "./Saga";
import { Treasury } from "./Treasury";
import { Progress, World } from "./World";
import { BOSSES } from "../lib/world";

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

  const serverName = state?.server.name;
  useEffect(() => {
    document.title = serverName ? `${serverName} - Skald` : "Skald";
  }, [serverName]);

  if (!state) {
    return (
      <main className="relative grid min-h-[100dvh] place-items-center">
        <Atmosphere dim />
        <p className="relative z-10 font-display text-lg tracking-wide text-ash">{t("app.loading")}</p>
      </main>
    );
  }

  const players = state.players;
  return (
    <ProfileProvider value={openProfile}>
      <div className="relative min-h-[100dvh]">
        <Atmosphere dim={!online} />
        {!online && <OfflineBanner />}
        <motion.main
          className="relative z-10 mx-auto max-w-[1320px] space-y-5 px-4 pb-16 pt-6 sm:px-6 lg:space-y-6 lg:pt-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8 }}
        >
          <Header state={state} online={online} now={now} onLogout={onLogout} />

          <div className="grid gap-5 lg:grid-cols-12 lg:gap-6">
            <section className="plank plank-charred flex flex-col items-center justify-center px-4 py-10 sm:py-14 lg:col-span-8" aria-label={t("plank.joinCode")}>
              <JoinCode code={state.server.joinCode} codeAt={state.server.joinCodeAt} status={state.server.status} now={now} />
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
              <Progress bosses={BOSSES} />
            </Plank>
          </div>

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
                  series={[{ name: t("online.series"), points: state.history.online7d, color: "#ff7a1a" }]}
                  step
                  height={110}
                  format={(v) => t("online.value", { n: Math.round(v) })}
                  timeFormat={(v) => `${dayLabel(new Date(v).toISOString(), now)}, ${clock(v)}`}
                  empty={t("online.empty")}
                  ticks={{ every: 86_400_000, format: (v) => new Date(v).toLocaleDateString(intl, { weekday: "short" }) }}
                />
              </Plank>
            </div>
          </div>

          <Plank title={t("plank.forge")} id="forge" aside={state.metricsConfigured === false ? undefined : t("plank.forge.aside")}>
            <Forge state={state} now={now} />
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
            <Chronicle lines={logs} />
          </Plank>
        </motion.main>
        <AnimatePresence>{profile && <ProfileSheet key={profile} name={profile} now={now} onClose={closeProfile} />}</AnimatePresence>
      </div>
    </ProfileProvider>
  );
}
