import { useMemo } from "react";
import { useI18n } from "../../i18n";

/** "1st", "2nd", "3rd" in English, "1.", "2." in Polish: the language's own ordinal rules. */
export function useOrdinal(): (n: number) => string {
  const { lookup, intl } = useI18n();
  const rules = useMemo(() => new Intl.PluralRules(intl, { type: "ordinal" }), [intl]);
  return (n: number) => lookup(`nth.${rules.select(n)}`, { n }) ?? lookup("nth.other", { n }) ?? String(n);
}

/** A stack seen from the side: one box per chest, the one meant filled. */
export function StackGlyph({ total, index, className = "" }: { total: number; index: number; className?: string }) {
  const h = 4;
  const gap = 1.5;
  const H = total * h + (total - 1) * gap;
  return (
    <svg width="12" height={H} viewBox={`0 0 12 ${H}`} aria-hidden className={`shrink-0 ${className}`}>
      {Array.from({ length: total }, (_, i) => (
        // Bottom chest at the bottom.
        <rect key={i} x="0.75" y={H - (i + 1) * h - i * gap + 0.75} width="10.5" height={h - 1.5} rx="0.75" fill={i === index ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.2" opacity={i === index ? 1 : 0.55} />
      ))}
    </svg>
  );
}

/** Where a chest sits in its stack: "3rd from the bottom of 3", with the glyph. */
export function StackLevel({ index, total, ordered = true, className = "" }: { index: number; total: number; ordered?: boolean; className?: string }) {
  const { t, number } = useI18n();
  const nth = useOrdinal();
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <StackGlyph total={total} index={ordered ? index : -1} className="text-flame" />
      <span>{ordered ? t("stack.level", { nth: nth(index + 1), total: number(total) }) : t("stack.unknown", { total: number(total) })}</span>
    </span>
  );
}
