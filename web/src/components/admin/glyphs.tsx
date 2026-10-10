// Own line drawings for the admin layer, on a 24 x 24 box.

export function KeyGlyph({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#f3b867" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3M15.5 12v2" />
    </svg>
  );
}

/** A hammer over an anvil: the admin's mark. */
export function AdminGlyph({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M4 20h16M7 20l1.5-4h7L17 20M9 16v-2h6v2" />
      <path d="M13.5 3.5l4 4M11 6l4-4 4 4-4 4zM12.5 8.5L7 14" />
    </svg>
  );
}
