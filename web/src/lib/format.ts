// Locale-independent text helpers. Everything a reader sees goes through the
// i18n layer (src/i18n), including numbers, dates and durations.

/** Valheim prefixes its own lines with `MM/DD/YYYY HH:MM:SS: `; the time column already shows that. */
export function stripValheimStamp(line: string): string {
  return stripAnsi(line).replace(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}: /, "");
}

// Valheim reports its build as "l-1.0.17"; the "l-" prefix reads as "I-" in Cinzel.
export function gameVersion(v: string | null | undefined): string {
  return v ? v.replace(/^[a-z]-/, "") : "?";
}

/** steamcmd colours its output; drop the escape codes (and orphaned `[0m` left when ESC was eaten). */
export function stripAnsi(line: string): string {
  return line.replace(/\x1b?\[[0-9;]*m/g, "").replace(/\^\[/g, "");
}
