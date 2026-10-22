import { memo, useMemo } from "react";
import type { ApiState, SeriesPoint } from "../types";
import { modLevel, useI18n } from "../i18n";
import { processRows, type ProcessTone } from "../lib/processes";
import { Chart } from "./Chart";
import { RelativeTime } from "./RelativeTime";

const DOCS_METRICS = "https://github.com/krystianslowik/skald#metrics-and-alerts";

function last(points: SeriesPoint[] | undefined): number | null {
  return points && points.length > 0 ? points[points.length - 1]![1] : null;
}

/** Highest value in a series, the denominator for the HUD meters. */
function peak(points: SeriesPoint[] | undefined): number {
  let m = 0;
  for (const p of points ?? []) if (p[1] > m) m = p[1];
  return m;
}

function Gauge({ title, value, of, children }: { title: string; value: string | null; of?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold uppercase tracking-[0.08em] text-label">{title}</h3>
        <span className="text-sm font-bold tabular-nums text-flame">
          {value ?? "?"}
          {of && <span className="font-normal text-ash"> / {of}</span>}
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * A HUD resource bar in the game's style (health, stamina and eitr bars).
 * With a known limit (the game container's memory limit) the fill is the
 * current value as a share of it, and the 6-hour peak is a tick on the bar.
 * Without one (CPU and network have none; memory when the agent was not told
 * the limit) the fill is the current value as a share of the 6-hour peak.
 * The label says which.
 */
function Meter({
  kind,
  points,
  value,
  label,
  limit = 0,
  format = String,
}: {
  kind: "hp" | "stamina" | "eitr";
  points: SeriesPoint[];
  value: string;
  label: string;
  limit?: number;
  format?: (n: number) => string;
}) {
  const { t } = useI18n();
  const top = peak(points);
  const now = last(points) ?? 0;
  // No samples yet: nothing to set against the limit either.
  const cap = points.length > 0 ? limit : 0;
  const max = cap > 0 ? cap : top;
  const frac = max > 0 ? Math.min(1, now / max) : 0;
  const pct = Math.round(frac * 100);
  const mark = cap > 0 && top > 0 ? Math.min(1, top / cap) : null;
  const text = cap > 0 ? t("forge.meterLimit", { value, pct, limit: format(cap), peak: format(top) }) : t("forge.meter", { value, pct });
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={text} title={text} className={`meter meter-${kind} mb-2 h-3.5`}>
      <span className="meter-fill" style={{ transform: `scaleX(${frac})` }} />
      {mark !== null && <span aria-hidden data-testid="meter-peak" className="meter-mark" style={{ left: `clamp(0px, calc(${(mark * 100).toFixed(2)}% - 1px), calc(100% - 2px))` }} />}
      <span aria-hidden className="meter-value">
        {value}
      </span>
    </div>
  );
}

/** What each line of a chart is, under it: every chart has one, so the three stand even. */
function Legend({ items }: { items: { color: string; label: string; value?: string }[] }) {
  return (
    <p className="mt-1.5 flex min-h-4 flex-wrap gap-x-4 gap-y-0.5 text-[0.6875rem] leading-4 text-ash">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-3" style={{ background: it.color }} />
          {it.label}
          {it.value && <span className="tabular-nums text-label">{it.value}</span>}
        </span>
      ))}
    </p>
  );
}

const TONE_TEXT: Record<ProcessTone, string> = { ok: "text-flame", busy: "text-gold", idle: "text-ash", bad: "text-blood" };
const TONE_DOT: Record<ProcessTone, string> = { ok: "bg-flame", busy: "bg-gold", idle: "bg-iron", bad: "bg-blood" };

/** The container's processes by what they do; the plumbing as one "system" line. */
function Processes({ processes }: { processes: Record<string, string> }) {
  const { t, lookup } = useI18n();
  const rows = processRows(processes);
  if (rows.length === 0) return <p className="text-xs text-ash">{t("forge.noData")}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center justify-between gap-3 text-sm" title={r.key === "process.system" ? t("process.systemHint", { names: r.names.join(", ") }) : r.names[0]}>
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[r.tone]}`} />
            <span className="truncate text-bone">{lookup(r.key) ?? r.names[0]!.replace(/^valheim-/, "")}</span>
          </span>
          <span className={`shrink-0 text-xs font-bold ${TONE_TEXT[r.tone]}`}>{lookup(r.state) ?? r.state}</span>
        </li>
      ))}
    </ul>
  );
}

/** Shown instead of the three charts when PROM_URL is unset: what they are and how to light them. */
function MetricsOff() {
  const { t } = useI18n();
  return (
    <div className="slot flex flex-col items-start gap-4 px-5 py-6 sm:flex-row sm:items-center lg:col-span-3">
      <svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-iron">
        <path d="M6 36h32M10 30l7-9 6 5 9-13" opacity="0.55" />
        <path d="M30 8c1.5 2.5 3 3.6 3 5.6a3 3 0 0 1-6 0c0-1.3.9-2.4 1.6-3.6.4.8.8 1.2 1.4 1.4-.3-1.2-.3-2.3 0-3.4z" stroke="#f3b867" />
      </svg>
      <div className="min-w-0 max-w-prose">
        <h3 className="text-sm font-bold uppercase tracking-[0.08em] text-flame">{t("forge.promOff.title")}</h3>
        <p className="mt-1 text-sm leading-relaxed text-ash">{t("forge.promOff.body")}</p>
        <a
          href={DOCS_METRICS}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-sm font-bold text-flame underline decoration-flame/40 underline-offset-4 transition-colors hover:text-gold hover:decoration-gold"
        >
          {t("forge.promOff.link")}
        </a>
      </div>
    </div>
  );
}

/** Forge: what the server is burning through, plus the world itself. */
export const Forge = memo(function Forge({
  metrics: m,
  metricsConfigured,
  server,
  world,
}: {
  metrics: ApiState["metrics"];
  metricsConfigured: ApiState["metricsConfigured"];
  server: ApiState["server"];
  world: ApiState["world"];
}) {
  const { t, tn, lookup, number, bytes, rate, clock, modifiers } = useI18n();
  const empty = t("forge.promDown");
  // Stable chart inputs: the charts only redraw when their own series change.
  const charts = useMemo(
    () => ({
      hours: { every: 2 * 3_600_000, format: clock },
      cores: (v: number) => t("forge.cores", { n: number(v, 2) }),
      cpu: [{ name: t("forge.legendCpu"), points: m?.cpu ?? [], color: "#e0484b" }],
      memory: [{ name: t("forge.legendMemory"), points: m?.memory ?? [], color: "#d9b44a" }],
      network: [
        { name: t("forge.rx"), points: m?.rx ?? [], color: "#d655bf" },
        { name: t("forge.tx"), points: m?.tx ?? [], color: "#e0c7c2", fill: false },
      ],
    }),
    [m, t, number, clock],
  );
  const { hours, cores } = charts;
  // The world's own modifiers when the save is readable: the launch
  // arguments can leave them out and the world still plays with them.
  const worldMods = world.meta?.modifiers;
  const worldKeys = world.meta?.worldKeys;
  const mods = useMemo(() => {
    if (!worldMods) return modifiers(server.args);
    const args = server.args.split(/\s+/);
    const out = args.includes("-crossplay") ? ["crossplay"] : [];
    for (const [k, v] of Object.entries(worldMods)) out.push(`${lookup(`mod.${k}`) ?? k}: ${modLevel(lookup, k, v)}`);
    // resourcerate mirrors the resources modifier; the rest are plain keys.
    const keys = new Set((worldKeys ?? []).filter((k) => !k.startsWith("resourcerate")));
    args.forEach((w, i) => w === "-setkey" && args[i + 1] && keys.add(args[i + 1]!.toLowerCase()));
    for (const key of keys) out.push(lookup(`worldkey.${key}`) ?? lookup(`setkey.${key}`)?.toLowerCase() ?? key);
    return out;
  }, [modifiers, lookup, server.args, worldMods, worldKeys]);
  const cpuNow = m ? cores(last(m.cpu) ?? 0) : null;
  const memNow = m ? bytes(last(m.memory) ?? 0) : null;
  // Older agents leave it out; null or 0 means the limit is unknown.
  const memLimit = Math.max(0, server.memoryLimitBytes ?? 0);
  const rxNow = m ? rate(last(m.rx) ?? 0) : null;
  return (
    <div className="space-y-6">
      {metricsConfigured === false ? (
        <MetricsOff />
      ) : (
        // Three gauges built the same way: title and value, a bar, the chart, its legend.
        <div className="grid gap-x-8 gap-y-7 md:grid-cols-3">
          <Gauge title={t("forge.cpu")} value={cpuNow}>
            <Meter kind="hp" points={m?.cpu ?? []} value={cpuNow ?? "?"} label={t("forge.cpu")} />
            <Chart label={t("forge.cpuLabel")} series={charts.cpu} format={cores} timeFormat={clock} empty={empty} ticks={hours} />
            <Legend items={[{ color: "#e0484b", label: t("forge.legendCpu") }]} />
          </Gauge>
          <Gauge title={t("forge.memory")} value={memNow} of={memLimit > 0 && m && m.memory.length > 0 ? bytes(memLimit) : undefined}>
            <Meter kind="stamina" points={m?.memory ?? []} value={memNow ?? "?"} label={t("forge.memory")} limit={memLimit} format={bytes} />
            <Chart label={t("forge.memoryLabel")} series={charts.memory} format={bytes} timeFormat={clock} empty={empty} ticks={hours} />
            <Legend items={[{ color: "#d9b44a", label: t("forge.legendMemory") }]} />
          </Gauge>
          <Gauge title={t("forge.network")} value={rxNow}>
            <Meter kind="eitr" points={m?.rx ?? []} value={rxNow ?? "?"} label={t("forge.network")} />
            <Chart label={t("forge.networkLabel")} series={charts.network} format={rate} timeFormat={clock} empty={empty} ticks={hours} />
            <Legend
              items={[
                { color: "#d655bf", label: t("forge.rx"), value: rxNow ?? undefined },
                { color: "#e0c7c2", label: t("forge.tx"), value: m ? rate(last(m.tx) ?? 0) : undefined },
              ]}
            />
          </Gauge>
        </div>
      )}
      {/* The world and the container under the charts: facts, modifiers and processes side by side. */}
      <div className="grid gap-x-8 gap-y-5 border-t border-iron/40 pt-5 text-sm sm:grid-cols-2 lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(0,16rem)]">
        <dl className="grid grid-cols-2 content-start gap-x-4 gap-y-3 sm:grid-cols-1 lg:order-1">
          <div>
            <dt className="text-xs text-ash">{t("forge.worldSize")}</dt>
            <dd className="font-bold text-bone">{bytes(world.sizeBytes)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ash">{t("forge.lastSave")}</dt>
            <dd className="font-bold text-bone">
              <RelativeTime iso={world.lastSaveAt ?? world.meta?.savedAt} />
              {world.lastSaveMs > 0 && <span className="text-ash">, {world.lastSaveMs} ms</span>}
            </dd>
          </div>
          {server.netStats && (
            <div className="col-span-2 sm:col-span-1">
              <dt className="text-xs text-ash">{t("forge.objects")}</dt>
              <dd className="font-bold text-bone">
                {number(server.netStats.zdos)}
                <span className="text-ash">, {tn("forge.connections", server.netStats.connections)}</span>
              </dd>
            </div>
          )}
        </dl>
        <section aria-label={t("forge.processes")} className="lg:order-3">
          <h3 className="mb-2 text-xs text-ash">{t("forge.processes")}</h3>
          <Processes processes={server.processes} />
        </section>
        <section aria-label={t("forge.modifiers")} className="sm:col-span-2 lg:order-2 lg:col-span-1">
          <h3 className="mb-2 text-xs text-ash">{t("forge.modifiers")}</h3>
          <div className="flex flex-wrap gap-1.5">
            {mods.length === 0 && <span className="text-bone">{t("forge.defaultModifiers")}</span>}
            {mods.map((x) => (
              <span key={x} className="plaque px-1.5 py-0.5 text-xs font-bold text-flame">
                {x}
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
});
