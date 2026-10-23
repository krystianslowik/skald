import type { I18n } from "../i18n";

/** The bridge's answer to sim-handover (plugin 0.7.0+), or an audit event's copy of it. */
export interface HandoverResult {
  objects: number;
  zones: number;
  fromPeers: number;
  already: number;
  inUse: number;
  capped: boolean;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** The counts out of an answer, missing or odd ones as 0. */
export function handoverResult(data: unknown): HandoverResult {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return { objects: count(d.objects), zones: count(d.zones), fromPeers: count(d.fromPeers), already: count(d.already), inUse: count(d.inUse), capped: d.capped === true };
}

/**
 * The toast after a handover: "Ragnar now simulates 1,058 more objects, in 6
 * zones (2 in use stay)", or why nothing moved: the player ran it all already,
 * or nobody else simulated anything near them.
 */
export function handoverText(i: Pick<I18n, "t" | "tn">, player: string, data: unknown): string {
  const r = handoverResult(data);
  if (r.objects === 0) {
    if (r.inUse > 0) return i.tn("admin.handover.onlyInUse", r.inUse, { player });
    return i.t(r.already > 0 ? "admin.handover.already" : "admin.handover.nothing", { player });
  }
  const parts = [i.tn("admin.handover.done", r.objects, { player, zones: i.tn("admin.sim.zones", r.zones) })];
  if (r.inUse > 0) parts.push(i.tn("admin.handover.inUse", r.inUse));
  if (r.capped) parts.push(i.t("admin.handover.capped"));
  return parts.join(" · ");
}
