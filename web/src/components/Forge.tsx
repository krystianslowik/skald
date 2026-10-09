import type { ApiState, SeriesPoint } from "../types";
import { useI18n } from "../i18n";
import { Chart } from "./Chart";

const DOCS_METRICS = "https://github.com/krystianslowik/skald#metrics-and-alerts";

function last(points: SeriesPoint[] | undefined): number | null {
  return points && points.length > 0 ? points[points.length - 1]![1] : null;
}

function Gauge({ title, value, children }: { title: string; value: string | null; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-display text-sm font-semibold tracking-wide text-bone/90">{title}</h3>
        <span className="text-sm tabular-nums text-flame">{value ?? "?"}</span>
      </div>
      {children}
    </div>
  );
}

/** Shown instead of the three charts when PROM_URL is unset: what they are and how to light them. */
function MetricsOff() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-start gap-4 rounded-md border border-dashed border-iron/40 bg-black/15 px-5 py-6 sm:flex-row sm:items-center lg:col-span-3">
      <svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-iron">
        <path d="M6 36h32M10 30l7-9 6 5 9-13" opacity="0.55" />
        <path d="M30 8c1.5 2.5 3 3.6 3 5.6a3 3 0 0 1-6 0c0-1.3.9-2.4 1.6-3.6.4.8.8 1.2 1.4 1.4-.3-1.2-.3-2.3 0-3.4z" className="text-ember" stroke="#ff7a1a" />
      </svg>
      <div className="min-w-0 max-w-prose">
        <h3 className="font-display text-sm font-semibold tracking-wide text-bone/90">{t("forge.promOff.title")}</h3>
        <p className="mt-1 text-sm leading-relaxed text-ash">{t("forge.promOff.body")}</p>
        <a
          href={DOCS_METRICS}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-sm text-flame underline decoration-ember/40 underline-offset-4 transition-colors hover:decoration-flame"
        >
          {t("forge.promOff.link")}
        </a>
      </div>
    </div>
  );
}

/** Forge: what the server is burning through, plus the world itself. */
export function Forge({ state, now }: { state: ApiState; now: number }) {
  const { t, tn, lookup, number, ago, bytes, rate, clock, modifiers } = useI18n();
  const m = state.metrics;
  const empty = t("forge.promDown");
  const hours = { every: 2 * 3_600_000, format: (v: number) => clock(v) };
  const cores = (v: number) => t("forge.cores", { n: number(v, 2) });
  const mods = modifiers(state.server.args);
  return (
    <div className="grid gap-x-8 gap-y-7 lg:grid-cols-[1fr_1fr_1fr_17rem]">
      {state.metricsConfigured === false ? (
        <MetricsOff />
      ) : (
        <>
          <Gauge title={t("forge.cpu")} value={m ? cores(last(m.cpu) ?? 0) : null}>
            <Chart label={t("forge.cpuLabel")} series={[{ name: "CPU", points: m?.cpu ?? [], color: "#ff7a1a" }]} format={cores} timeFormat={clock} empty={empty} ticks={hours} />
          </Gauge>
          <Gauge title={t("forge.memory")} value={m ? bytes(last(m.memory) ?? 0) : null}>
            <Chart label={t("forge.memoryLabel")} series={[{ name: "RAM", points: m?.memory ?? [], color: "#ffb347" }]} format={bytes} timeFormat={clock} empty={empty} ticks={hours} />
          </Gauge>
          <Gauge title={t("forge.network")} value={m ? rate(last(m.rx) ?? 0) : null}>
            <Chart
              label={t("forge.networkLabel")}
              series={[
                { name: t("forge.rx"), points: m?.rx ?? [], color: "#ffb347" },
                { name: t("forge.tx"), points: m?.tx ?? [], color: "#c2412d", fill: false },
              ]}
              format={rate}
              timeFormat={clock}
              empty={empty}
              ticks={hours}
            />
            {m && (
              <div className="mt-1 flex gap-4 text-[11px] text-ash">
                <span><span className="mr-1.5 inline-block h-0.5 w-3 align-middle bg-flame" />{t("forge.rx")}</span>
                <span><span className="mr-1.5 inline-block h-0.5 w-3 align-middle bg-blood" />{t("forge.tx")} {rate(last(m.tx) ?? 0)}</span>
              </div>
            )}
          </Gauge>
        </>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 border-t border-iron/30 pt-5 text-sm lg:grid-cols-1 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
        <div>
          <dt className="text-xs text-ash">{t("forge.worldSize")}</dt>
          <dd className="text-bone">{bytes(state.world.sizeBytes)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ash">{t("forge.lastSave")}</dt>
          <dd className="text-bone">
            {ago(state.world.lastSaveAt ?? state.world.meta?.savedAt, now)}
            {state.world.lastSaveMs > 0 && <span className="text-ash">, {state.world.lastSaveMs} ms</span>}
          </dd>
        </div>
        {state.server.netStats && (
          <div>
            <dt className="text-xs text-ash">{t("forge.objects")}</dt>
            <dd className="text-bone">
              {number(state.server.netStats.zdos)}
              <span className="text-ash">, {tn("forge.connections", state.server.netStats.connections)}</span>
            </dd>
          </div>
        )}
        <div className="col-span-2 lg:col-span-1">
          <dt className="text-xs text-ash">{t("forge.modifiers")}</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {mods.length === 0 && <span className="text-bone">{t("forge.defaultModifiers")}</span>}
            {mods.map((x) => (
              <span key={x} className="rounded border border-ember/25 bg-ember/[0.07] px-1.5 py-0.5 text-xs text-flame/90">
                {x}
              </span>
            ))}
          </dd>
        </div>
        <div className="col-span-2 lg:col-span-1">
          <dt className="text-xs text-ash">{t("forge.processes")}</dt>
          <dd className="mt-1 space-y-0.5">
            {Object.entries(state.server.processes).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 text-xs">
                <span className="text-bone/80">{lookup(`process.${k}`) ?? k}</span>
                <span className={v === "RUNNING" ? "text-flame" : "text-blood"}>{v === "RUNNING" ? t("forge.running") : v.toLowerCase()}</span>
              </div>
            ))}
            {Object.keys(state.server.processes).length === 0 && <span className="text-xs text-ash">{t("forge.noData")}</span>}
          </dd>
        </div>
      </dl>
    </div>
  );
}
