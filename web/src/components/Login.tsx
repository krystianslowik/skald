import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { LocaleToggle, useI18n } from "../i18n";
import { login } from "../lib/api";
import { Atmosphere } from "./Atmosphere";

function Campfire({ lit }: { lit: boolean }) {
  return (
    <svg viewBox="0 0 200 170" className="w-[220px] overflow-visible sm:w-[260px]" aria-hidden>
      <defs>
        <radialGradient id="cf-glow" cx="50%" cy="78%" r="55%">
          <stop offset="0%" stopColor="#ff7a1a" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#ff7a1a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="cf-outer" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#c2410c" />
          <stop offset="60%" stopColor="#ff7a1a" />
          <stop offset="100%" stopColor="#ffb347" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id="cf-inner" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#ffb347" />
          <stop offset="100%" stopColor="#fff3d6" />
        </linearGradient>
      </defs>
      <motion.ellipse cx="100" cy="135" rx="95" ry="45" fill="url(#cf-glow)" animate={{ opacity: lit ? 1 : [0.35, 0.55, 0.4, 0.5, 0.35] }} transition={lit ? { duration: 0.4 } : { duration: 3.2, repeat: Infinity }} />
      {/* stones */}
      {[30, 52, 76, 100, 124, 148, 170].map((x, i) => (
        <ellipse key={x} cx={x} cy={150 + (i % 2) * 3} rx="13" ry="7" fill={i % 2 ? "#3d3833" : "#4a4540"} stroke="#1a1714" />
      ))}
      {/* logs */}
      <path d="M40 140 L150 118" stroke="#3a2a1d" strokeWidth="13" strokeLinecap="round" />
      <path d="M160 140 L52 116" stroke="#2f2117" strokeWidth="13" strokeLinecap="round" />
      <path d="M78 128 L122 128" stroke="#1f150e" strokeWidth="10" strokeLinecap="round" />
      {/* char glow on the logs */}
      <motion.path d="M86 124 L116 124" stroke="#ff7a1a" strokeWidth="3" strokeLinecap="round" animate={{ opacity: lit ? 1 : [0.3, 0.8, 0.4, 0.7, 0.3] }} transition={{ duration: 2.4, repeat: lit ? 0 : Infinity }} />
      <motion.g style={{ transformOrigin: "100px 126px" }} initial={false} animate={{ scale: lit ? 2.6 : 1 }} transition={{ type: "spring", stiffness: 70, damping: 9 }}>
        <path className="flame-sway" d="M100 84 C104 96 114 100 113 112 C112.5 120 107 126 100 126 C93 126 87.5 120 87 113 C86.5 104 93 100 94 92 C96 97 97.5 99 99 99.5 C98 94 98 89 100 84 Z" fill="url(#cf-outer)" opacity={lit ? 1 : 0.7} />
        <path className="flame-sway-fast" d="M100 102 C102 107 106 109 105.5 114 C105 119 102.5 122 100 122 C97.5 122 95 119 95 116 C95 112 98 109 100 102 Z" fill="url(#cf-inner)" />
      </motion.g>
    </svg>
  );
}

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  useEffect(() => {
    document.title = "Skald";
  }, []);
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [lit, setLit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!word || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await login(word);
      if (r.ok) {
        setLit(true);
        setTimeout(onSuccess, reduced ? 150 : 1300);
        return;
      }
      setShake((n) => n + 1);
      setWord("");
      setError(
        r.retryAfter ? t("login.locked", { min: Math.ceil(r.retryAfter / 60) }) : t("login.wrong"),
      );
      input.current?.focus();
    } catch {
      setError(t("login.offline"));
    }
    setBusy(false);
  };

  return (
    <main className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden px-4 py-10">
      <Atmosphere dim={!lit} />
      <LocaleToggle className="absolute right-4 top-4 z-20" />
      <div className="relative z-10 flex w-full max-w-sm flex-col items-center text-center">
        <Campfire lit={lit} />
        <motion.h1
          className="mt-6 font-display text-3xl font-semibold tracking-wide text-bone sm:text-4xl"
          animate={{ opacity: lit ? 0 : 1, y: lit ? -10 : 0 }}
        >
          {t("login.title")}
        </motion.h1>
        <motion.p className="mt-2 text-sm leading-relaxed text-ash" animate={{ opacity: lit ? 0 : 1 }}>
          {t("login.subtitle")}
        </motion.p>
        <motion.form
          key={shake}
          onSubmit={submit}
          className="mt-7 w-full"
          animate={shake && !reduced ? { x: [0, -10, 9, -6, 4, 0] } : { opacity: lit ? 0 : 1 }}
          transition={{ duration: 0.45 }}
        >
          <label htmlFor="word" className="sr-only">
            {t("login.placeholder")}
          </label>
          <input
            ref={input}
            id="word"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={word}
            onChange={(e) => setWord(e.target.value)}
            placeholder={t("login.placeholder")}
            disabled={busy || lit}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "word-err" : undefined}
            className="w-full rounded-md border border-iron/50 bg-black/40 px-4 py-3 text-center font-display text-lg tracking-[0.2em] text-flame placeholder:font-display placeholder:tracking-wider placeholder:text-ash/50 focus:border-ember/70 focus:shadow-[0_0_24px_-4px_rgba(255,122,26,0.55)] focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || lit || !word}
            className="mt-3 w-full rounded-md border border-ember/40 bg-gradient-to-b from-[#3a2414] to-[#22150c] py-2.5 font-display font-semibold tracking-wider text-flame transition-[border-color,box-shadow] enabled:hover:border-ember enabled:hover:shadow-[0_0_20px_-6px_#ff7a1a] disabled:opacity-50"
          >
            {busy ? t("login.busy") : t("login.submit")}
          </button>
          <p id="word-err" role="alert" className="mt-3 min-h-[1.25rem] text-sm text-[#e3a091]">
            {error}
          </p>
        </motion.form>
      </div>
      <AnimatePresence>
        {lit && !reduced && (
          <motion.div
            className="pointer-events-none fixed inset-0 z-50"
            style={{ background: "radial-gradient(circle at 50% 45%, rgba(255,214,150,0.95), rgba(255,122,26,0.75) 30%, rgba(15,11,8,0) 70%)" }}
            initial={{ opacity: 0, scale: 0.3 }}
            animate={{ opacity: [0, 1, 0.9], scale: [0.3, 1.6, 2.4] }}
            transition={{ duration: 1.3, ease: [0.3, 0.6, 0.3, 1] }}
          />
        )}
      </AnimatePresence>
    </main>
  );
}
