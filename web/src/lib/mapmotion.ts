// Motion for the map: momentum after a fling and a critically damped spring
// for programmatic moves (zoom buttons, search, "go to the other end").
// Pure functions, stepped from requestAnimationFrame.

/** Scroll-like deceleration per millisecond (UIScrollView's normal rate). */
export const DECELERATION = 0.998;

/** Below this speed (px/s) a fling has come to rest. */
export const REST_SPEED = 12;

/** Advance a fling by `dtMs`: the distance travelled and the velocity left. */
export function inertiaStep(v: number, dtMs: number, rate = DECELERATION): { d: number; v: number } {
  const k = Math.pow(rate, dtMs);
  // Exact integral of v * rate^t over the step.
  const d = Math.abs(1 - rate) < 1e-9 ? (v * dtMs) / 1000 : ((v / 1000) * (k - 1)) / Math.log(rate);
  return { d, v: v * k };
}

/**
 * One step of a critically damped spring (damping ratio 1): no overshoot,
 * settles in about `response` seconds, and starts from the current value and
 * velocity, so a new target mid-flight bends the motion instead of jumping.
 */
export function springStep(x: number, v: number, target: number, dtSec: number, response = 0.4): { x: number; v: number } {
  const w = (2 * Math.PI) / response;
  const e = Math.exp(-w * dtSec);
  const d = x - target;
  const c = v + w * d;
  return { x: target + (d + c * dtSec) * e, v: (c - w * (d + c * dtSec)) * e };
}

/** Release velocity in px/s from recent pointer samples (newest last), over the last 100 ms. */
export function releaseVelocity(samples: readonly { x: number; y: number; t: number }[]): [number, number] {
  const last = samples.at(-1);
  if (!last) return [0, 0];
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (last.t - s.t > 100) break;
    first = s;
  }
  const dt = last.t - first.t;
  if (dt <= 0) return [0, 0];
  return [((last.x - first.x) / dt) * 1000, ((last.y - first.y) / dt) * 1000];
}
