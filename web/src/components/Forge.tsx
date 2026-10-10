import { memo, useMemo } from "react";
import type { ApiState, SeriesPoint } from "../types";
import { useI18n } from "../i18n";
import { Chart } from "./Chart";

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

function Gauge({ title, value, children }: { title: string; value: string | null; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold uppercase tracking-[0.08em] text-label">{title}</h3>
        <span className="text-sm font-bold tabular-nums text-flame">{value ?? "?"}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * A HUD resource bar in the game's style (health column, stamina and eitr bars).
 * There is no CPU or memory limit to measure against, so the fill is the current
 * value as a share of the 6-hour peak; the label says so.
 */
function Meter({ kind, points, value, label }: { kind: "hp" | "stamina" | "eitr"; points: SeriesPoint[]; value: string; label: string }) {
  const { t } = useI18n();
  const top = peak(points);
  const now = last(points) ?? 0;
  const frac = top > 0 ? Math.min(1, now / top) : 0;
  const pct = Math.round(frac * 100);
  const vertical = kind === "hp";
  const text = t("forge.meter", { value, pct });
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={text}
      title={text}
      className={`meter meter-${kind} ${vertical ? "meter-v w-4 shrink-0" : "mb-2 h-3.5"}`}
      style={vertical ? { height: 120 } : undefined}
    >
      <span className="meter-fill" style={{ transform: vertical ? `scaleY(${frac})` : `scaleX(${frac})` }} />
      {!vertical && (
        <span aria-hidden className="meter-value">
          {value}
        </span>
      )}
    </div>
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
  now,
}: {
  metrics: ApiState["metrics"];
  metricsConfigured: ApiState["metricsConfigured"];
  server: ApiState["server"];
  world: ApiState["world"];
  now: number;
}) {
  const { t, tn, lookup, number, ago, bytes, rate, clock, modifiers } = useI18n();
  const empty = t("forge.promDown");
  // Stable chart inputs: the charts only redraw when their own series change.
  const charts = useMemo(
    () => ({
      hours: { every: 2 * 3_600_000, format: clock },
      cores: (v: number) => t("forge.cores", { n: number(v, 2) }),
      cpu: [{ name: "CPU", points: m?.cpu ?? [], color: "#e0484b" }],
      memory: [{ name: "RAM", points: m?.memory ?? [], color: "#d9b44a" }],
      network: [
        { name: t("forge.rx"), points: m?.rx ?? [], color: "#d655bf" },
        { name: t("forge.tx"), points: m?.tx ?? [], color: "#e0c7c2", fill: false },
      ],
    }),
    [m, t, number, clock],
  );
  const { hours, cores } = charts;
  const mods = useMemo(() => modifiers(server.args), [modifiers, server.args]);
  return (
    <div className="grid gap-x-8 gap-y-7 lg:grid-cols-[1fr_1fr_1fr_17rem]">
      {metricsConfigured === false ? (
        <MetricsOff />
      ) : (
        <>
          <Gauge title={t("forge.cpu")} value={m ? cores(last(m.cpu) ?? 0) : null}>
            <div className="flex items-start gap-2.5">
              {m && m.cpu.length > 0 && <Meter kind="hp" points={m.cpu} value={cores(last(m.cpu) ?? 0)} label={t("forge.cpu")} />}
              <div className="min-w-0 flex-1">
                <Chart label={t("forge.cpuLabel")} series={charts.cpu} format={cores} timeFormat={clock} empty={empty} ticks={hours} />
              </div>
            </div>
          </Gauge>
          <Gauge title={t("forge.memory")} value={m ? bytes(last(m.memory) ?? 0) : null}>
            {m && m.memory.length > 0 && <Meter kind="stamina" points={m.memory} value={bytes(last(m.memory) ?? 0)} label={t("forge.memory")} />}
            <Chart label={t("forge.memoryLabel")} series={charts.memory} format={bytes} timeFormat={clock} empty={empty} ticks={hours} />
          </Gauge>
          <Gauge title={t("forge.network")} value={m ? rate(last(m.rx) ?? 0) : null}>
            {m && m.rx.length > 0 && <Meter kind="eitr" points={m.rx} value={rate(last(m.rx) ?? 0)} label={t("forge.network")} />}
            <Chart
              label={t("forge.networkLabel")}
              series={charts.network}
              format={rate}
              timeFormat={clock}
              empty={empty}
              ticks={hours}
            />
            {m && (
              <div className="mt-1 flex gap-4 text-[0.6875rem] text-ash">
                <span><span className="mr-1.5 inline-block h-0.5 w-3 align-middle bg-eitr" />{t("forge.rx")}</span>
                <span><span className="mr-1.5 inline-block h-0.5 w-3 align-middle bg-label" />{t("forge.tx")} {rate(last(m.tx) ?? 0)}</span>
              </div>
            )}
          </Gauge>
        </>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 border-t border-iron/40 pt-5 text-sm lg:grid-cols-1 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
        <div>
          <dt className="text-xs text-ash">{t("forge.worldSize")}</dt>
          <dd className="font-bold text-bone">{bytes(world.sizeBytes)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ash">{t("forge.lastSave")}</dt>
          <dd className="font-bold text-bone">
            {ago(world.lastSaveAt ?? world.meta?.savedAt, now)}
            {world.lastSaveMs > 0 && <span className="text-ash">, {world.lastSaveMs} ms</span>}
          </dd>
        </div>
        {server.netStats && (
          <div>
            <dt className="text-xs text-ash">{t("forge.objects")}</dt>
            <dd className="font-bold text-bone">
              {number(server.netStats.zdos)}
              <span className="text-ash">, {tn("forge.connections", server.netStats.connections)}</span>
            </dd>
          </div>
        )}
        <div className="col-span-2 lg:col-span-1">
          <dt className="text-xs text-ash">{t("forge.modifiers")}</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {mods.length === 0 && <span className="text-bone">{t("forge.defaultModifiers")}</span>}
            {mods.map((x) => (
              <span key={x} className="plaque px-1.5 py-0.5 text-xs font-bold text-flame">
                {x}
              </span>
            ))}
          </dd>
        </div>
        <div className="col-span-2 lg:col-span-1">
          <dt className="text-xs text-ash">{t("forge.processes")}</dt>
          <dd className="mt-1 space-y-0.5">
            {Object.entries(server.processes).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 text-xs">
                <span className="text-bone/80">{lookup(`process.${k}`) ?? k}</span>
                <span className={v === "RUNNING" ? "text-flame" : "text-blood"}>{v === "RUNNING" ? t("forge.running") : v.toLowerCase()}</span>
              </div>
            ))}
            {Object.keys(server.processes).length === 0 && <span className="text-xs text-ash">{t("forge.noData")}</span>}
          </dd>
        </div>
      </dl>
    </div>
  );
});
