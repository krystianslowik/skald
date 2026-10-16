// The game writes some names as its own localization tokens rather than text:
// a Vegvisir's boss pin is named "$enemy_gdking", not "The Elder". They are
// turned into the panel's own words here, and never shown raw.

type Lookup = (key: string) => string | undefined;

/** Bosses whose token differs from the key they are known by elsewhere in the panel. */
const BOSS_ALIAS: Record<string, string> = { seekerqueen: "queen" };

/** Prefixes that say what kind of thing a token names; dropped when nothing better is known. */
const PREFIX = /^((enemy|location|loc|hud|pin|piece|npc|item|biome)_)+/;

/** A token nothing is known about, as words: "$location_old_tower" is "Old tower", "$hud_pin_hildir1" "Hildir1". */
export function humanizeToken(token: string): string {
  const words = token.replace(/^\$+/, "").replace(PREFIX, "").replace(/_+/g, " ").trim();
  if (!words) return "?";
  return words[0]!.toUpperCase() + words.slice(1);
}

/** One "$token" in the viewer's language: an "$enemy_" token as the boss's name on the progress board, anything else humanized. */
function tokenName(raw: string, lookup: Lookup): string {
  const token = raw.replace(/^\$+/, "").toLowerCase();
  const boss = /^enemy_(.+)$/.exec(token)?.[1];
  if (boss) {
    const known = lookup(`boss.defeated_${BOSS_ALIAS[boss] ?? boss}`);
    if (known) return known;
  }
  return humanizeToken(token);
}

/** A name as the game gave it, every "$token" in it put into words: plain text stays as it is. */
export function gameName(name: string, lookup: Lookup): string {
  return name.includes("$") ? name.replace(/\$+[A-Za-z][A-Za-z0-9_]*/g, (m) => tokenName(m, lookup)) : name;
}
