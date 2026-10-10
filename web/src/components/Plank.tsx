import type { ReactNode } from "react";

/** An amber rule that ends in a small carved diamond next to the title. */
function Flourish({ side }: { side: "left" | "right" }) {
  return (
    <span aria-hidden className={`flex min-w-4 flex-1 items-center ${side === "right" ? "flex-row-reverse" : ""}`}>
      <span className={`plank-rule h-[2px] flex-1 ${side === "left" ? "plank-rule-l" : "plank-rule-r"}`} />
      <svg width="14" height="10" viewBox="0 0 14 10" className="shrink-0" fill="none" stroke="#e0a24a" strokeWidth="1.3" strokeLinejoin="round">
        <path d={side === "left" ? "M1 5h4l3-3 3 3-3 3-3-3" : "M13 5H9L6 2 3 5l3 3 3-3"} />
      </svg>
    </span>
  );
}

/** A wooden board, like the game's crafting and inventory panels: the one container style the page uses. */
export function Plank({
  title,
  aside,
  children,
  className = "",
  id,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = id ? `${id}-h` : undefined;
  return (
    <section className={`plank min-w-0 px-5 pb-5 pt-5 sm:px-6 ${className}`} aria-labelledby={headingId}>
      {title && (
        // Centred amber caps between two carved rules, like the title of a crafting station.
        <header className="mb-4 text-center">
          <div className="flex items-center gap-2.5 sm:gap-3">
            <Flourish side="left" />
            <h2 id={headingId} className="plank-title max-w-[80%] text-base sm:text-[1.0625rem]">
              {title}
            </h2>
            <Flourish side="right" />
          </div>
          {aside && <div className="mt-1 truncate text-xs text-ash">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
