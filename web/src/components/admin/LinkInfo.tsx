import { useI18n, type I18n } from "../../i18n";
import { GAP_FAIR_S, linkVerdict, QUEUE_FAIR_B, QUEUE_POOR_B, VERDICT_TONE } from "../../lib/link";
import type { PlayerLink as Live } from "../../lib/adminlinks";
import { Section } from "./parts";

/** "Link: poor (ping 240 ms)", or without the ping when the socket gives none; null when nothing is known. */
export function linkText({ t }: Pick<I18n, "t">, p: Live): string | null {
  const v = linkVerdict(p.link);
  if (!v) return null;
  const verdict = t(`admin.link.${v}`);
  return p.link?.pingMs != null ? t("admin.link.line", { verdict, ms: p.link.pingMs }) : t("admin.link.lineNoPing", { verdict });
}

/** "Simulates the area: 1,240 objects"; null when the bridge did not say. */
export function simText({ tn }: Pick<I18n, "tn">, p: Live): string | null {
  return p.sim ? tn("admin.sim.line", p.sim.owned) : null;
}

/**
 * One quiet line under a player's row: their link and what they simulate,
 * so a laggy area can be traced to the player who runs it. Nothing when the
 * bridge reports neither (a plugin before 0.6.0).
 */
export function LinkLine({ p, className = "" }: { p: Live | undefined; className?: string }) {
  const i18n = useI18n();
  if (!p) return null;
  const link = linkText(i18n, p);
  const sim = simText(i18n, p);
  if (!link && !sim) return null;
  const v = linkVerdict(p.link);
  return (
    <span className={`block truncate text-xs ${className}`}>
      {link && <span className={v ? VERDICT_TONE[v] : "text-ash"}>{link}</span>}
      {link && sim && (
        <span aria-hidden className="text-ash">
          {" · "}
        </span>
      )}
      {sim && <span className="text-ash">{sim}</span>}
    </span>
  );
}

/** The player sheet's view: the verdict, what makes it, what they simulate, and why it matters. */
export function LinkDetail({ p }: { p: Live }) {
  const i18n = useI18n();
  const { t, tn, number } = i18n;
  const l = p.link;
  const link = linkText(i18n, p);
  const sim = simText(i18n, p);
  if (!link && !p.sim) return null;
  const v = linkVerdict(l);
  const facts: string[] = [];
  if (l?.pingMaxMs != null && l.pingMs != null && l.pingMaxMs > l.pingMs) facts.push(t("admin.link.worst", { ms: l.pingMaxMs }));
  if (l?.replyGapMaxS != null && l.replyGapMaxS >= GAP_FAIR_S) facts.push(t("admin.link.stall", { s: number(l.replyGapMaxS, 1) }));
  if (l?.queueBytes != null && l.queueBytes > QUEUE_FAIR_B) facts.push(t(l.queueBytes > QUEUE_POOR_B ? "admin.link.held" : "admin.link.queue", { kb: number(l.queueBytes / 1024, 0) }));
  if (l?.pingMs == null) {
    if (l?.pingUnsure) facts.push(t("admin.link.pingUnsure"));
    else if (l?.transport === "crossplay") facts.push(t("admin.link.noPing"));
  }
  return (
    <Section title={t("admin.link.title")}>
      <div className="slot space-y-1.5 px-3 py-2.5 text-sm">
        {link && (
          <p>
            <span className={`font-bold ${v ? VERDICT_TONE[v] : "text-bone"}`}>{link}</span>
            {facts.length > 0 && <span className="block text-xs text-ash">{facts.join(" · ")}</span>}
          </p>
        )}
        {p.sim && (
          <p>
            <span className="font-bold text-bone">{sim}</span>
            <span className="block text-xs text-ash">
              {p.sim.owned > 0 ? t("admin.sim.of", { nearby: number(p.sim.nearby), zones: tn("admin.sim.zones", p.sim.zones) }) : p.sim.nearby > 0 ? t("admin.sim.someoneElse") : t("admin.sim.empty")}
            </span>
          </p>
        )}
      </div>
      <p className="mt-2 text-xs text-ash">{t("admin.link.hint")}</p>
    </Section>
  );
}
