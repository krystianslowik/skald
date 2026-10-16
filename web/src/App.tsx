import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Dashboard } from "./components/Dashboard";
import { Login } from "./components/Login";
import { I18nProvider, loadLocale, serverLocale, storedLocale, type Locale } from "./i18n";
import { getConfig, logout, me } from "./lib/api";
import { setIconBuild } from "./lib/itemicons";
import { useValheim } from "./lib/useValheim";

function Panel({ onUnauthorized, onLogout }: { onUnauthorized: () => void; onLogout: () => void }) {
  const live = useValheim(onUnauthorized);
  const icons = live.state?.icons;
  // Item icons follow the agent's sheet: loaded once per game build.
  useEffect(() => setIconBuild(icons), [icons]);
  return <Dashboard live={live} onLogout={onLogout} onUnauthorized={onUnauthorized} />;
}

export default function App() {
  const [auth, setAuth] = useState<"checking" | "out" | "in">("checking");
  // The viewer's stored choice wins; otherwise the server's SKALD_LOCALE, which
  // the served page carries. Only `vite` dev (no server-side page) asks the API.
  const [locale, setLocale] = useState<Locale | null>(() => storedLocale() ?? serverLocale());

  useEffect(() => {
    if (locale) {
      // Fetch the dictionary alongside the session check, not after it.
      loadLocale(locale).catch(() => undefined);
      return;
    }
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

  const blank = <div className="min-h-dvh bg-coal" />;
  if (auth === "checking" || !locale) return blank;
  return (
    <I18nProvider locale={locale} fallback={blank}>
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
