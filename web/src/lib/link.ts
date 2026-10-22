// How a player's connection and simulation load read in the admin views.
// The bridge only measures; the thresholds live here so they can change
// without a game restart.

import type { LinkQuality } from "../types";

export type LinkVerdict = "good" | "fair" | "poor";

/** Median keep-alive round trip (ms) from which a link is fair, and poor: good is below 120, fair below 250. */
export const PING_FAIR_MS = 120;
export const PING_POOR_MS = 250;
/**
 * Longest wait for a keep-alive reply (s). The game pings once a second, so
 * a healthy link answers about every second; a gap well past that is a stall.
 */
export const GAP_FAIR_S = 1.6;
export const GAP_POOR_S = 2.5;
/**
 * Bytes the server still has to get through to the player. ZDOMan.SendZDOs
 * sends world updates only with 2 KiB of room under 10 KiB, so above 8 KiB
 * the player gets none until it drains: over this is poor, over half fair.
 */
export const QUEUE_FAIR_B = 4096;
export const QUEUE_POOR_B = 8192;

const rank = { good: 0, fair: 1, poor: 2 } as const;
const worse = (a: LinkVerdict, b: LinkVerdict): LinkVerdict => (rank[b] > rank[a] ? b : a);
const grade = (v: number | undefined, fair: number, poor: number): LinkVerdict => (v == null ? "good" : v >= poor ? "poor" : v >= fair ? "fair" : "good");

/** The worst of ping, stalls and the send queue; null when none of them is known. */
export function linkVerdict(l: LinkQuality | undefined): LinkVerdict | null {
  // An unsure ping (left out by the plugin) is no verdict of its own: with
  // no ping, stalls and the backlog decide.
  if (!l || (l.pingMs == null && l.replyGapMaxS == null && l.queueBytes == null)) return null;
  let v = grade(l.pingMs, PING_FAIR_MS, PING_POOR_MS);
  v = worse(v, grade(l.replyGapMaxS, GAP_FAIR_S, GAP_POOR_S));
  // Strictly over, like the game's own check.
  const q = l.queueBytes;
  return worse(v, q == null ? "good" : q > QUEUE_POOR_B ? "poor" : q > QUEUE_FAIR_B ? "fair" : "good");
}

/** Text colour per verdict: quiet when fine, the stamina yellow, the warning red. */
export const VERDICT_TONE: Record<LinkVerdict, string> = {
  good: "text-ash",
  fair: "text-stamina",
  poor: "text-blood",
};
