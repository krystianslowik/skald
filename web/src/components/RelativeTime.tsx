import { memo } from "react";
import { useI18n } from "../i18n";
import { useNow } from "../lib/useNow";

// Leaves that print a time relative to now. Each one re-renders on the shared
// tick on its own, so the boards around them stay still.

/** "5 min ago", optionally inside a sentence: `format` gets the phrase. */
export const RelativeTime = memo(function RelativeTime({ iso, format }: { iso: string | null | undefined; format?: (ago: string) => string }) {
  const { ago } = useI18n();
  const text = ago(iso, useNow());
  return <>{format ? format(text) : text}</>;
});

/** How long since `since`: "2 h 10 min". */
export const Elapsed = memo(function Elapsed({ since }: { since: string }) {
  const { duration } = useI18n();
  return <>{duration(useNow() - Date.parse(since))}</>;
});

/** "Today", "Yesterday" or the date. */
export const DayLabel = memo(function DayLabel({ iso }: { iso: string }) {
  const { dayLabel } = useI18n();
  return <>{dayLabel(iso, useNow())}</>;
});
