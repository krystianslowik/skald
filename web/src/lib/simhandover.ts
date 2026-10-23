import type { I18n } from "../i18n";

/** The bridge's answer to sim-handover (plugin 0.7.0+), or an audit event's copy of it. */
export interface HandoverResult {
  objects: number;
  zones: number;
  fromPeers: number;
  already: number;
  inUse: number;
  /** Items on the ground, left alone (plugin 0.7.0 after #203's review). */
  loose: number;
  /** Objects that hold or work items (chests, smelters, pickables...), left alone. */
  kept: number;
  /** Objects the plugin could not move. */
  failed: number;
  capped: boolean;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** The counts out of an answer, missing or odd ones as 0. */
export function handoverResult(data: unknown): HandoverResult {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return { objects: count(d.objects), zones: count(d.zones), fromPeers: count(d.fromPeers), already: count(d.already), inUse: count(d.inUse), loose: count(d.loose), kept: count(d.kept), failed: count(d.failed), capped: d.capped === true };
}

/**
 * The toast after a handover: "Ragnar now simulates 1,058 more objects, in 6
 * zones · 2 in use stay · a few may go back ...", or why nothing moved: the
 * player ran it all already, or nobody else simulated anything near them.
 * The game itself can hand some back at once (a ship to a player aboard),
 * so the toast says so rather than promise every object.
 */
export function handoverText(i: Pick<I18n, "t" | "tn">, player: string, data: unknown): string {
  const r = handoverResult(data);
  const leftAlone = r.loose + r.kept;
  if (r.objects === 0) {
    if (r.failed > 0) return i.tn("admin.handover.failedAll", r.failed, { player });
    if (r.inUse > 0) return i.tn("admin.handover.onlyInUse", r.inUse, { player });
    // Only things that hold items or lie on the ground: left alone on purpose, not "nothing there".
    if (leftAlone > 0 && r.already === 0) return i.tn("admin.handover.leftAlone", leftAlone, { player });
    return i.t(r.already > 0 ? "admin.handover.already" : "admin.handover.nothing", { player });
  }
  const parts = [i.tn("admin.handover.done", r.objects, { player, zones: i.tn("admin.sim.zones", r.zones) })];
  if (r.inUse > 0) parts.push(i.tn("admin.handover.inUse", r.inUse));
  if (leftAlone > 0) parts.push(i.tn("admin.handover.kept", leftAlone));
  if (r.failed > 0) parts.push(i.tn("admin.handover.failed", r.failed));
  if (r.capped) parts.push(i.t("admin.handover.capped"));
  parts.push(i.t("admin.handover.mayReturn"));
  return parts.join(" · ");
}
