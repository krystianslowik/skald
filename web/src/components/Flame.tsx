export type FlameLevel = "alive" | "embers" | "ash";

/** The hearth glyph used for status: a full flame, a low glow, or cold ash. */
export function Flame({ level, size = 40, className = "" }: { level: FlameLevel; size?: number; className?: string }) {
  const id = `fl-${level}`;
  return (
    <svg width={size} height={size * 1.25} viewBox="0 0 40 50" className={className} aria-hidden>
      <defs>
        <radialGradient id={`${id}-glow`} cx="50%" cy="80%" r="60%">
          <stop offset="0%" stopColor="#ff7a1a" stopOpacity={level === "ash" ? 0 : level === "embers" ? 0.35 : 0.6} />
          <stop offset="100%" stopColor="#ff7a1a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-outer`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#c2410c" />
          <stop offset="55%" stopColor="#ff7a1a" />
          <stop offset="100%" stopColor="#ffb347" stopOpacity="0.9" />
        </linearGradient>
        <linearGradient id={`${id}-inner`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#ffb347" />
          <stop offset="100%" stopColor="#fff1d0" />
        </linearGradient>
      </defs>
      <ellipse cx="20" cy="40" rx="19" ry="12" fill={`url(#${id}-glow)`} />
      {/* crossed logs */}
      <path d="M6 45 L32 39" stroke="#3a2a1d" strokeWidth="4.5" strokeLinecap="round" />
      <path d="M34 45 L8 39" stroke="#2f2117" strokeWidth="4.5" strokeLinecap="round" />
      {level === "alive" && (
        <>
          <path className="flame-sway" d="M20 6 C23 14 31 18 30 29 C29.5 36 25 40 20 40 C15 40 10.5 36 10 30 C9.5 23 14 20 15 14 C17 18 18 20 19.5 20.5 C18.5 15 18.5 10 20 6 Z" fill={`url(#${id}-outer)`} />
          <path className="flame-sway-fast" d="M20 20 C22 25 26 27 25.5 32 C25 36 22.5 38.5 20 38.5 C17.5 38.5 15 36 15 33 C15 29 18 27 20 20 Z" fill={`url(#${id}-inner)`} />
        </>
      )}
      {level === "embers" && (
        <>
          <ellipse className="flame-sway" cx="20" cy="38" rx="9" ry="3.5" fill="#ff7a1a" opacity="0.75" />
          <path className="flame-sway-fast" d="M20 28 C21.5 31 23.5 32.5 23 35 C22.5 37 21 38 20 38 C18.5 38 17 37 17 35.2 C17 33 19 31.5 20 28 Z" fill={`url(#${id}-inner)`} opacity="0.85" />
        </>
      )}
      {level === "ash" && (
        <>
          <ellipse cx="20" cy="38.5" rx="10" ry="3" fill="#4a4540" />
          <path d="M17 33 q2 -4 0 -8 M23 31 q-2 -4 0 -9" stroke="#5b5650" strokeWidth="1.2" fill="none" strokeLinecap="round" opacity="0.6" />
        </>
      )}
    </svg>
  );
}
