import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Dashboard } from "./components/Dashboard";
import { Login } from "./components/Login";
import { ChunkBoundary } from "./components/ErrorBoundary";
import { I18nProvider, loadLocale, serverLocale, storedLocale, type Locale } from "./i18n";
import { dropTerrainTiles, getConfig, logout, me, type LogoutResult } from "./lib/api";
import { setIconBuild } from "./lib/itemicons";
import { useValheim } from "./lib/useValheim";

function Panel({ onUnauthorized, onLogout }: { onUnauthorized: () => void; onLogout: () => Promise<LogoutResult> }) {
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
    // Unknown (offline, server restarting): open the panel anyway. It keeps
    // retrying, and the first 401 it meets sends the viewer to the login.
    me()
      .then((ok) => setAuth(ok ? "in" : "out"))
      .catch(() => setAuth("in"));
  }, []);

  const toLogin = useCallback(() => {
    void dropTerrainTiles();
    setAuth("out");
  }, []);
  // Only the server can clear the HttpOnly session cookie: the login screen
  // comes once it confirms, else the panel stays and says so (useLogout).
  const doLogout = useCallback(async () => {
    const r = await logout();
    if (r === "ok") setAuth("out");
    return r;
  }, []);

  const blank = <div className="min-h-dvh bg-coal" />;
  if (auth === "checking" || !locale) return blank;
  return (
    <I18nProvider locale={locale} fallback={blank}>
      <ChunkBoundary resetKey={auth}>
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
      </ChunkBoundary>
    </I18nProvider>
  );
}
