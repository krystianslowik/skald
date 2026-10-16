import { memo, useEffect, useRef } from "react";
import { useEmbers } from "../lib/embers";

interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  max: number;
  hue: number;
  wobble: number;
}

const COUNT = 42;
const HUE_MIN = 14;
const HUE_SPAN = 20;
const HUE_STEPS = 12;
const SPRITE = 32;
/** Embers drift slowly: 30 frames a second look the same and cost half of 60. */
const FRAME_MS = 1000 / 30;

/**
 * One pre-rendered glow per hue band, drawn with globalAlpha each frame: far
 * cheaper than building a radial gradient per ember per frame.
 */
function sprites(): HTMLCanvasElement[] {
  return Array.from({ length: HUE_STEPS }, (_, i) => {
    const hue = HUE_MIN + (i / (HUE_STEPS - 1)) * HUE_SPAN;
    const c = document.createElement("canvas");
    c.width = c.height = SPRITE;
    const g = c.getContext("2d");
    if (!g) return c;
    const r = SPRITE / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, `hsla(${hue + 12}, 100%, 72%, 1)`);
    grad.addColorStop(0.3, `hsla(${hue}, 95%, 50%, 0.55)`);
    grad.addColorStop(1, `hsla(${hue}, 100%, 50%, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE, SPRITE);
    return c;
  });
}

function spawn(w: number, h: number, initial: boolean): Ember {
  const max = 6 + Math.random() * 9;
  return {
    x: w * (0.15 + Math.random() * 0.7) + (Math.random() - 0.5) * w * 0.3,
    y: initial ? h * (0.3 + Math.random() * 0.7) : h + 10,
    vx: (Math.random() - 0.5) * 12,
    vy: -(18 + Math.random() * 42),
    r: 0.6 + Math.random() * 1.8,
    life: initial ? Math.random() * max : 0,
    max,
    hue: Math.floor(Math.random() * HUE_STEPS),
    wobble: Math.random() * Math.PI * 2,
  };
}

/**
 * Rising embers on a canvas behind the page. Gone when switched off in the
 * preferences (off by default under reduced motion); paused when the tab is
 * hidden or `paused` (the map covers them).
 */
export const Embers = memo(function Embers({ intensity = 1, paused = false }: { intensity?: number; paused?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { on } = useEmbers();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !ctx || paused) return;

    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const n = Math.round(COUNT * intensity);
    const embers = Array.from({ length: n }, () => spawn(w, h, true));
    const glow = sprites();
    let raf = 0;
    let last = performance.now();

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      // Draw every other frame at 60 Hz; the slack keeps timing jitter from making it every third.
      if (t - last < FRAME_MS - 4) return;
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < embers.length; i++) {
        let e = embers[i]!;
        e.life += dt;
        if (e.life > e.max || e.y < -20) e = embers[i] = spawn(w, h, false);
        e.wobble += dt * 2.2;
        e.x += (e.vx + Math.sin(e.wobble) * 14) * dt;
        e.y += e.vy * dt;
        const k = e.life / e.max;
        const alpha = Math.sin(Math.PI * Math.min(1, k)) * (0.4 + 0.3 * Math.sin(t / 90 + i));
        if (alpha <= 0.01) continue;
        const size = e.r * 6.5;
        ctx.globalAlpha = alpha;
        ctx.drawImage(glow[e.hue]!, e.x - size / 2, e.y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
    };

    const start = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const onVis = () => (document.hidden ? cancelAnimationFrame(raf) : start());
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("resize", resize, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      // Paused or restarted: no frozen embers left on the canvas.
      ctx.clearRect(0, 0, w, h);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", resize);
    };
  }, [intensity, paused, on]);

  if (!on) return null;
  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-1 h-full w-full" />;
});

export const Atmosphere = memo(function Atmosphere({ dim = false, paused = false }: { dim?: boolean; paused?: boolean }) {
  return (
    <>
      <div className="firelight" aria-hidden style={dim ? { opacity: 0.6 } : undefined} />
      <div className="treeline" aria-hidden />
      <Embers intensity={dim ? 0.25 : 1} paused={paused} />
      <div className="vignette" aria-hidden />
      <div className="grain" aria-hidden />
    </>
  );
});
