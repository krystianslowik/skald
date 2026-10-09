const PALETTES: [string, string][] = [
  ["#7a2318", "#d8c3a0"],
  ["#1f3a4a", "#c9a96a"],
  ["#2f4a22", "#d8c3a0"],
  ["#5a2f12", "#e0b25a"],
  ["#3b2547", "#d0b98a"],
  ["#6a4a1a", "#2a1d14"],
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A round Viking shield painted in colours derived from the player's name. */
export function Shield({ name, size = 84, dim = false }: { name: string; size?: number; dim?: boolean }) {
  const h = hash(name);
  const [a, b] = PALETTES[h % PALETTES.length]!;
  const pattern = (h >> 4) % 3;
  const rivets = Array.from({ length: 12 }, (_, i) => {
    const t = (i / 12) * Math.PI * 2;
    return [50 + Math.cos(t) * 43, 50 + Math.sin(t) * 43] as const;
  });
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden style={dim ? { filter: "grayscale(0.7) brightness(0.6)" } : undefined}>
      <defs>
        <radialGradient id={`boss-${h}`} cx="40%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#b9b2a8" />
          <stop offset="55%" stopColor="#5b5650" />
          <stop offset="100%" stopColor="#1e1b18" />
        </radialGradient>
        <radialGradient id={`sheen-${h}`} cx="50%" cy="100%" r="80%">
          <stop offset="0%" stopColor="#ff7a1a" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#ff7a1a" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`face-${h}`}>
          <circle cx="50" cy="50" r="44" />
        </clipPath>
      </defs>
      <circle cx="50" cy="50" r="48" fill="#3d3833" stroke="#1a1714" strokeWidth="2" />
      <g clipPath={`url(#face-${h})`}>
        <rect width="100" height="100" fill={a} />
        {pattern === 0 && (
          <>
            <path d="M50 50 L50 0 L100 0 L100 50 Z" fill={b} />
            <path d="M50 50 L50 100 L0 100 L0 50 Z" fill={b} />
          </>
        )}
        {pattern === 1 && <path d="M50 50 L30 0 L70 0 Z M50 50 L100 30 L100 70 Z M50 50 L70 100 L30 100 Z M50 50 L0 70 L0 30 Z" fill={b} />}
        {pattern === 2 && <path d="M50 50 m-30 0 a30 30 0 1 0 60 0 a30 30 0 1 0 -60 0 M50 50 m-18 0 a18 18 0 1 1 36 0 a18 18 0 1 1 -36 0" fill={b} fillRule="evenodd" />}
        {/* plank seams */}
        {[22, 36, 50, 64, 78].map((x) => (
          <line key={x} x1={x} y1="0" x2={x} y2="100" stroke="rgba(0,0,0,0.22)" strokeWidth="0.8" />
        ))}
        <rect width="100" height="100" fill={`url(#sheen-${h})`} />
      </g>
      {rivets.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="1.6" fill="#8b847c" stroke="#1a1714" strokeWidth="0.5" />
      ))}
      <circle cx="50" cy="50" r="12" fill={`url(#boss-${h})`} stroke="#141210" strokeWidth="1.2" />
    </svg>
  );
}
