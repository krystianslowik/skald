import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

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

const COUNT = 60;

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
    hue: 18 + Math.random() * 22,
    wobble: Math.random() * Math.PI * 2,
  };
}

/** Rising embers on a canvas behind the page. Paused when the tab is hidden or motion is reduced. */
export function Embers({ intensity = 1 }: { intensity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !ctx || reduced) return;

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
    let raf = 0;
    let last = performance.now();

    const frame = (t: number) => {
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
        const alpha = Math.sin(Math.PI * Math.min(1, k)) * (0.55 + 0.45 * Math.sin(t / 90 + i));
        const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.r * 4);
        g.addColorStop(0, `hsla(${e.hue + 10}, 100%, 75%, ${alpha})`);
        g.addColorStop(0.35, `hsla(${e.hue}, 100%, 55%, ${alpha * 0.6})`);
        g.addColorStop(1, `hsla(${e.hue}, 100%, 50%, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r * 4, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const onVis = () => (document.hidden ? cancelAnimationFrame(raf) : start());
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", resize);
    };
  }, [reduced, intensity]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-[1] h-full w-full" />;
}

export function Atmosphere({ dim = false }: { dim?: boolean }) {
  return (
    <>
      <div className="firelight" aria-hidden style={dim ? { opacity: 0.35, animation: "none" } : undefined} />
      <Embers intensity={dim ? 0.25 : 1} />
      <div className="vignette" aria-hidden />
      <div className="grain" aria-hidden />
    </>
  );
}
