// Refusals from the admin bridge, the agent and the server, in the panel's
// language. They arrive as English text: the bridge's messages are fixed
// literals (bridge/plugin/*.cs, agent/internal/bridge/bridge.go), so each
// one is matched by its wording here. The status is not used: the saga gets
// the text without one, and the agent turns some statuses into 502.

import type { I18n, TextKey } from "../i18n";
import { itemLabel } from "./storage";

type Vars = Record<string, string | number>;
type Labels = Pick<I18n, "t" | "lookup">;

interface Rule {
  re: RegExp;
  key: TextKey;
  /** The message's parts as the line's variables, already labelled. */
  vars?: (m: RegExpMatchArray, i: Labels) => Vars;
}

const item = (name: string, i: Labels) => itemLabel(name, i.lookup);
/** The short ore and mead-base names of the fill flow ("Copper"), else the item's name. */
const fillItem = (name: string, i: Labels) => i.lookup(`admin.fill.item.${name}`) ?? itemLabel(name, i.lookup);
const creature = (name: string, i: Labels) => i.lookup(`creature.${name}`) ?? name;

const RULES: Rule[] = [
  // chest-add (bridge/plugin/Chests.cs)
  { re: /^a player has that chest open; /, key: "admin.refusal.chestOpen" },
  { re: /^(.+) is standing at that chest; try again once they step away$/, key: "admin.refusal.chestNear", vars: (m) => ({ player: m[1]! }) },
  { re: /^only (\d+) (\S+) fit in that chest$/, key: "admin.refusal.chestFits", vars: (m, i) => ({ n: Number(m[1]), item: item(m[2]!, i) }) },
  { re: /^that chest has no room for (\S+)$/, key: "admin.refusal.chestNoRoom", vars: (m, i) => ({ item: item(m[1]!, i) }) },
  { re: /^no such chest at -?\d+, -?\d+ any more/, key: "admin.refusal.chestGone" },
  { re: /^two chests sit on that spot; /, key: "admin.refusal.chestTwo" },
  { re: /^that chest holds items this server does not know; /, key: "admin.refusal.chestUnknownItems" },
  { re: /^(that chest's items do not read back the same|the items did not fit as planned|the new contents do not read back the same); /, key: "admin.refusal.chestUnsafe" },
  { re: /^only chests can take items this way/, key: "admin.refusal.notChest" },
  { re: /^'.*' is not a container$/, key: "admin.refusal.notContainer" },
  { re: /^unknown item prefab '(.+)' \(use the prefab name/, key: "admin.refusal.unknownItem", vars: (m) => ({ item: m[1]! }) },
  // fill-smelters, fill-fermenters (bridge/plugin/Extras.cs)
  { re: /^no smelter takes '(.+)'; GET /, key: "admin.refusal.noSmelter", vars: (m, i) => ({ item: fillItem(m[1]!, i) }) },
  { re: /^no fermenter takes '(.+)'; GET /, key: "admin.refusal.noFermenter", vars: (m, i) => ({ item: fillItem(m[1]!, i) }) },
  // Any command aimed at a player (bridge and agent say it the same way).
  { re: /^no connected player '(.+)'$/, key: "admin.refusal.playerOffline", vars: (m) => ({ player: m[1]! }) },
  { re: /^no connected player '(.+)'; to ban an offline player /, key: "admin.refusal.playerOfflineBan", vars: (m) => ({ player: m[1]! }) },
  { re: /^more than one player is called '(.+)', use the uid$/, key: "admin.refusal.playerTwice", vars: (m) => ({ player: m[1]! }) },
  { re: /^player has no character yet/, key: "admin.refusal.noCharacter" },
  { re: /^player has no platform id to ban$/, key: "admin.refusal.noPlatformId" },
  { re: /^player and toPlayer are the same$/, key: "admin.refusal.samePlayer" },
  { re: /^no location '(.+)' in this world; /, key: "admin.refusal.unknownLocation", vars: (m) => ({ name: m[1]! }) },
  // Time, events, world keys, creatures, map tables, spawn.
  { re: /^already skipping time$/, key: "admin.refusal.skipping" },
  { re: /^time is already frozen$/, key: "admin.refusal.frozen" },
  { re: /^time is not frozen$/, key: "admin.refusal.notFrozen" },
  { re: /^no (random )?event is running$/, key: "admin.refusal.noEvent" },
  { re: /^unknown event '(.+)'; GET /, key: "admin.refusal.unknownEvent", vars: (m) => ({ name: m[1]! }) },
  { re: /^global key '(.+)' is not set$/, key: "admin.refusal.keyNotSet", vars: (m) => ({ key: m[1]! }) },
  { re: /^unknown creature prefab '(.+)' \(e\.g\. /, key: "admin.refusal.unknownCreature", vars: (m) => ({ name: m[1]! }) },
  { re: /^'(.+)' cannot be tamed$/, key: "admin.refusal.cannotTame", vars: (m, i) => ({ name: creature(m[1]!, i) }) },
  { re: /^no cartography table within (\d+(?:[.,]\d+)?) m$/, key: "admin.refusal.noTable", vars: (m) => ({ r: m[1]! }) },
  { re: /^too many stacks in one call/, key: "admin.refusal.tooManyStacks" },
  { re: /^not possible server-side/, key: "admin.refusal.notPossible" },
  // The bans list (agent).
  { re: /^not on the ban list \(reload it\)$|^'.+' is not on the ban list$/, key: "admin.refusal.notBanned" },
  // The game, the bridge or the agent not ready.
  { re: /^(world not loaded yet|EnvMan not available|RandEventSystem not available|ObjectDB not available)$/, key: "admin.refusal.worldLoading" },
  { re: /^untested game build (\S+): confirm it in the admin panel first$/, key: "admin.refusal.untested", vars: (m) => ({ build: m[1]! }) },
  { re: /^the bridge did not answer in time$/, key: "admin.refusal.timeout" },
  { re: /^agent unreachable$/, key: "admin.refusal.agentDown" },
];

/** The refusal in the panel's language, or null when the text is not a known one. */
export function refusalText(i: Labels, error: string | null | undefined): string | null {
  if (!error) return null;
  const text = error.trim();
  for (const r of RULES) {
    const m = text.match(r.re);
    if (m) return i.t(r.key, r.vars?.(m, i));
  }
  return null;
}

/**
 * The refusal as a reason for a past event (the Saga): its first sentence,
 * without the advice on what to do now. Null when the text is not a known one.
 */
export function refusalReason(i: Labels, error: string | null | undefined): string | null {
  const text = refusalText(i, error);
  return text === null ? null : text.split(/\. /)[0]!.replace(/\.$/, "");
}

/** What a failed admin call says: unreachable, a known refusal, the raw text, or "that did not work". */
export function failText(i: Labels, res: { status: number; error?: string }): string {
  if (res.status === 0 || res.status === 502) return i.t("admin.unreachable");
  return refusalText(i, res.error) ?? (res.error || i.t("admin.failed"));
}
