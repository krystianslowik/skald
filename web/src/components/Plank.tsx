import type { ReactNode } from "react";

/** A longhouse table plank: the one container style the page uses. */
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
    <section className={`plank min-w-0 px-5 pb-5 pt-6 sm:px-6 ${className}`} aria-labelledby={headingId}>
      {title && (
        <header className="mb-4 flex items-baseline justify-between gap-3 pl-3">
          <h2 id={headingId} className="plank-title text-lg sm:text-xl">
            {title}
          </h2>
          {aside && <div className="text-xs text-ash">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
