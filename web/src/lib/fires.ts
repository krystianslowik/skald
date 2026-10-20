import type { I18n } from "../i18n";

/** What people call the fires a refuel lit, from the game's prefab names. */
export type FireKind = "torch" | "campfire" | "hearth" | "brazier" | "lantern" | "candle" | "other";

const KINDS: FireKind[] = ["torch", "campfire", "hearth", "brazier", "lantern", "candle", "other"];

/** A count with no kinds to it: an event without `byPrefab`. */
type Group = { kind: FireKind | "any"; n: number };

// Braziers first: none of the others' words appear in their names.
const RULES: [RegExp, FireKind][] = [
  [/brazier/i, "brazier"],
  [/torch|sconce/i, "torch"],
  [/hearth/i, "hearth"],
  [/fire_?pit|bonfire|campfire/i, "campfire"],
  [/lantern|jackoturnip/i, "lantern"],
  [/candle/i, "candle"],
];

/** A fire prefab's kind; one the panel does not know yet is "other". */
export function fireKind(prefab: string): FireKind {
  return RULES.find(([re]) => re.test(prefab))?.[1] ?? "other";
}

/**
 * The bridge's `byPrefab` (prefab: fires refuelled) added up per kind, the
 * biggest first. With the `total` the bridge counted, fires the map leaves out
 * (an audit event keeps only the 20 biggest prefabs) count as other fires, or
 * as plain fires when there is no map at all.
 */
export function fireGroups(byPrefab: unknown, total = 0): Group[] {
  const sums = new Map<FireKind, number>();
  let counted = 0;
  if (byPrefab && typeof byPrefab === "object") {
    for (const [prefab, v] of Object.entries(byPrefab)) {
      const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
      if (n <= 0) continue;
      const kind = fireKind(prefab);
      sums.set(kind, (sums.get(kind) ?? 0) + n);
      counted += n;
    }
  }
  const rest = Math.max(0, total - counted);
  if (rest > 0 && counted === 0) return [{ kind: "any", n: rest }];
  if (rest > 0) sums.set("other", (sums.get("other") ?? 0) + rest);
  return [...sums]
    .map(([kind, n]) => ({ kind, n }))
    .sort((a, b) => b.n - a.n || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

/** "14 torches and 3 campfires": what a refuel lit, by kind. */
export function firesText(i: Pick<I18n, "tn" | "intl">, byPrefab: unknown, total = 0): string {
  const parts = fireGroups(byPrefab, total).map((g) => i.tn(`admin.refuel.kind.${g.kind}`, g.n));
  return new Intl.ListFormat(i.intl, { type: "conjunction" }).format(parts);
}
