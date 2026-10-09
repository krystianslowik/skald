import { useId, useMemo, useRef, useState } from "react";
import type { SeriesPoint } from "../types";
import { useI18n } from "../i18n";

export interface Series {
  name: string;
  points: SeriesPoint[];
  color: string;
  fill?: boolean;
}

const W = 600;

function pathFor(points: SeriesPoint[], x: (t: number) => number, y: (v: number) => number, step: boolean): string {
  let d = "";
  points.forEach(([t, v], i) => {
    const px = x(t).toFixed(1);
    const py = y(v).toFixed(1);
    if (i === 0) d += `M${px} ${py}`;
    else if (step) d += `H${px}V${py}`;
    else d += `L${px} ${py}`;
  });
  return d;
}

/**
 * Hand-rolled SVG area/line chart in ember colours with a hover readout.
 * Stretches to its container width; strokes stay crisp via non-scaling-stroke.
 */
export function Chart({
  series,
  height = 120,
  step = false,
  format,
  timeFormat,
  empty,
  yMin = 0,
  label,
  ticks,
}: {
  series: Series[];
  height?: number;
  step?: boolean;
  format: (v: number) => string;
  timeFormat: (t: number) => string;
  empty?: string;
  yMin?: number;
  label: string;
  /** Local-time aligned x-axis labels, e.g. every 2 h or every day. */
  ticks?: { every: number; format: (t: number) => string };
}) {
  const { t } = useI18n();
  const uid = useId().replace(/:/g, "");
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const pad = 6;

  const all = series.flatMap((s) => s.points);
  const geo = useMemo(() => {
    if (all.length < 2) return null;
    const t0 = Math.min(...all.map((p) => p[0]));
    const t1 = Math.max(...all.map((p) => p[0]));
    const vMax = Math.max(...all.map((p) => p[1]), yMin + 1e-9);
    const top = vMax * 1.15;
    const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
    const y = (v: number) => H - pad - ((v - yMin) / Math.max(1e-9, top - yMin)) * (H - pad * 2);
    return { t0, t1, x, y };
  }, [series, H, yMin]);

  if (!geo) {
    return (
      <div className="flex items-center justify-center rounded-md border border-dashed border-iron/40 text-xs text-ash" style={{ height }}>
        {empty ?? t("chart.empty")}
      </div>
    );
  }

  const tickTimes: number[] = [];
  if (ticks) {
    const d = new Date(geo.t0);
    d.setMinutes(0, 0, 0);
    if (ticks.every >= 86_400_000) d.setHours(0);
    else d.setHours(d.getHours() - (d.getHours() % Math.max(1, Math.round(ticks.every / 3_600_000))));
    for (let t = d.getTime(); t <= geo.t1; t += ticks.every) if (t > geo.t0) tickTimes.push(t);
  }

  const hoverT = hover === null ? null : geo.t0 + (hover / W) * (geo.t1 - geo.t0);
  const nearest = (pts: SeriesPoint[], t: number): SeriesPoint | undefined => {
    if (step) {
      let last = pts[0];
      for (const p of pts) {
        if (p[0] > t) break;
        last = p;
      }
      return last;
    }
    let best = pts[0];
    for (const p of pts) if (best && Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    return best;
  };

  const onMove = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    setHover(Math.max(0, Math.min(W, ((e.clientX - r.left) / r.width) * W)));
  };

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full touch-none"
        style={{ height: H }}
        role="img"
        aria-label={label}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={`${uid}-g${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.45" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {tickTimes.map((t) => (
          <line key={t} x1={geo.x(t)} x2={geo.x(t)} y1="0" y2={H} stroke="rgba(155,143,132,0.1)" vectorEffect="non-scaling-stroke" />
        ))}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="rgba(155,143,132,0.12)" strokeDasharray="2 6" vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((s, i) => {
          const line = pathFor(s.points, geo.x, geo.y, step);
          return (
            <g key={s.name}>
              {s.fill !== false && <path d={`${line}V${H}H${geo.x(s.points[0]![0]).toFixed(1)}Z`} fill={`url(#${uid}-g${i})`} />}
              <path d={line} fill="none" stroke={s.color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          );
        })}
        {hover !== null && <line x1={hover} x2={hover} y1="0" y2={H} stroke="rgba(255,179,71,0.5)" vectorEffect="non-scaling-stroke" />}
      </svg>
      {ticks && (
        <div className="relative mt-1 h-4 text-[10px] text-ash/70" aria-hidden>
          {tickTimes.map((t) => {
            const pct = (geo.x(t) / W) * 100;
            if (pct > 92) return null;
            return (
              <span key={t} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${pct}%` }}>
                {ticks.format(t)}
              </span>
            );
          })}
        </div>
      )}
      {hoverT !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded border border-ember/30 bg-coal/90 px-2 py-1 text-[11px] leading-tight shadow-lg"
          style={{ left: `${(hover! / W) * 100}%`, transform: `translateX(${hover! > W / 2 ? "calc(-100% - 8px)" : "8px"})` }}
        >
          <div className="text-ash">{timeFormat(hoverT)}</div>
          {series.map((s) => {
            const p = nearest(s.points, hoverT);
            return (
              <div key={s.name} className="whitespace-nowrap" style={{ color: s.color }}>
                {series.length > 1 ? `${s.name}: ` : ""}
                {p ? format(p[1]) : "?"}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
