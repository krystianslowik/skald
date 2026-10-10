import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Dashboard } from "./components/Dashboard";
import { Login } from "./components/Login";
import { I18nProvider, storedLocale, type Locale } from "./i18n";
import { getConfig, logout, me } from "./lib/api";
import { setIconBuild } from "./lib/itemicons";
import { useValheim } from "./lib/useValheim";

function Panel({ onUnauthorized, onLogout }: { onUnauthorized: () => void; onLogout: () => void }) {
  const live = useValheim(onUnauthorized);
  const icons = live.state?.icons;
  // Item icons follow the agent's sheet: loaded once per game build.
  useEffect(() => setIconBuild(icons), [icons]);
  return <Dashboard live={live} onLogout={onLogout} />;
}

export default function App() {
  const [auth, setAuth] = useState<"checking" | "out" | "in">("checking");
  // The viewer's stored choice wins; otherwise the server's SKALD_LOCALE.
  const [locale, setLocale] = useState<Locale | null>(storedLocale);

  useEffect(() => {
    if (locale) return;
    getConfig()
      .then((c) => setLocale(c.locale))
      .catch(() => setLocale("en"));
  }, [locale]);

  useEffect(() => {
    me()
      .then((ok) => setAuth(ok ? "in" : "out"))
      .catch(() => setAuth("out"));
  }, []);

  const toLogin = useCallback(() => setAuth("out"), []);
  const doLogout = useCallback(() => {
    void logout().finally(() => setAuth("out"));
  }, []);

  if (auth === "checking" || !locale) return <div className="min-h-[100dvh] bg-coal" />;
  return (
    <I18nProvider locale={locale}>
      {/* Reduced motion: transforms and layout animations are dropped app-wide, opacity cross-fades stay. */}
      <MotionConfig reducedMotion="user">
        <AnimatePresence mode="wait">
          {auth === "in" ? (
            <motion.div key="in" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Panel onUnauthorized={toLogin} onLogout={doLogout} />
            </motion.div>
          ) : (
            <motion.div key="out" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.3 } }}>
              <Login onSuccess={() => setAuth("in")} />
            </motion.div>
          )}
        </AnimatePresence>
      </MotionConfig>
    </I18nProvider>
  );
}
