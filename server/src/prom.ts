import { cause, log as defaultLog, type Logger } from "./log";
import type { Metrics, SeriesPoint } from "./types";

const RANGE_S = 6 * 60 * 60;
const STEP_S = 60;

/** Which cAdvisor series belong to the game server. */
export interface PromTarget {
  namespace: string;
  /** Container name of the game server (CPU and memory are per container). */
  container: string;
  /**
   * Regex for the game pod (network counters are per pod). PromQL anchors it,
   * so the default `valheim-<rs-hash>-<id>` never matches a pod named
   * `skald-web-...` or `valheim-web-<hash>-<id>`.
   */
  podRegex: string;
}

export const DEFAULT_TARGET: PromTarget = { namespace: "valheim", container: "valheim", podRegex: "valheim-[a-z0-9]+-[a-z0-9]+" };

/**
 * cAdvisor as scraped by kube-prometheus-stack: CPU/memory carry one row per
 * container plus a pod-level row with no `container` label, so filter the
 * container exactly. Network series are pod-level only (labels `pod`,
 * `interface`, no `container`).
 */
export function metricQueries(t: PromTarget = DEFAULT_TARGET): Record<keyof Metrics, string> {
  const c = `namespace="${t.namespace}",container="${t.container}"`;
  const p = `namespace="${t.namespace}",pod=~"${t.podRegex}"`;
  return {
    cpu: `sum(rate(container_cpu_usage_seconds_total{${c}}[2m]))`,
    memory: `sum(container_memory_working_set_bytes{${c}})`,
    rx: `sum(rate(container_network_receive_bytes_total{${p}}[2m]))`,
    tx: `sum(rate(container_network_transmit_bytes_total{${p}}[2m]))`,
  };
}

interface RangeResponse {
  status: string;
  data?: { result?: { values?: [number, string][] }[] };
}

async function queryRange(promUrl: string, query: string, now: number, fetchImpl: typeof fetch): Promise<SeriesPoint[]> {
  const end = Math.floor(now / 1000);
  const params = new URLSearchParams({ query, start: String(end - RANGE_S), end: String(end), step: String(STEP_S) });
  const res = await fetchImpl(`${promUrl}/api/v1/query_range?${params}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`prometheus: HTTP ${res.status}`);
  const body = (await res.json()) as RangeResponse;
  if (body.status !== "success") throw new Error("prometheus: query failed");
  const values = body.data?.result?.[0]?.values ?? [];
  return values.map(([t, v]) => [t * 1000, Number(v)] as SeriesPoint).filter(([, v]) => Number.isFinite(v));
}

/** Returns null when Prometheus is unreachable; the UI shows empty charts then. */
export async function fetchMetrics(
  promUrl: string,
  target: PromTarget = DEFAULT_TARGET,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
  log: Logger = defaultLog,
): Promise<Metrics | null> {
  const q = metricQueries(target);
  try {
    const [cpu, memory, rx, tx] = await Promise.all([
      queryRange(promUrl, q.cpu, now, fetchImpl),
      queryRange(promUrl, q.memory, now, fetchImpl),
      queryRange(promUrl, q.rx, now, fetchImpl),
      queryRange(promUrl, q.tx, now, fetchImpl),
    ]);
    return { cpu, memory, rx, tx };
  } catch (e) {
    log.warn("prometheus unreachable", { cause: cause(e) });
    return null;
  }
}

/** Cached wrapper: 6 h at 60 s steps changes once a minute at most. */
export function cachedMetrics(fetcher: () => Promise<Metrics | null>, ttlMs = 30_000, clock: () => number = Date.now) {
  let cache: { at: number; value: Metrics | null } | null = null;
  let inflight: Promise<Metrics | null> | null = null;
  return async (): Promise<Metrics | null> => {
    if (cache && clock() - cache.at < ttlMs) return cache.value;
    inflight ??= fetcher().finally(() => {
      inflight = null;
    });
    const value = await inflight;
    cache = { at: clock(), value };
    return value;
  };
}
