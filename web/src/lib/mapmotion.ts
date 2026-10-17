// Motion for the map: momentum after a fling and a critically damped spring
// for programmatic moves (zoom buttons, search, "go to the other end").
// Pure functions, stepped from requestAnimationFrame.

/** Scroll-like deceleration per millisecond (UIScrollView's normal rate). */
export const DECELERATION = 0.998;

/** Below this speed (px/s) a fling has come to rest. */
export const REST_SPEED = 12;

/** A pinch's momentum slows faster than a pan's: a zoom should not run on far past the fingers. */
export const ZOOM_DECELERATION = 0.994;

/** Below this zoom speed (log scale per second) a pinch's momentum has come to rest. */
export const ZOOM_REST = 0.05;

/** How far past a zoom limit a pinch can stretch at most, in log scale (about 40 %). */
export const RUBBER = Math.log(1.4);

/** How fast a rubber band gives at its limit: the stretch moves at this share of the motion behind it. */
export const BAND_SLOPE = 0.55;

/**
 * A log scale `x` past [lo, hi] pulled back towards the limit, ever more
 * stiffly the further it goes and never more than `d` past it: the rubber
 * band of a scroll view, so a limit gives way a little instead of stopping
 * the fingers dead.
 */
export function rubberBand(x: number, lo: number, hi: number, d = RUBBER): number {
  const band = (o: number) => (1 - 1 / ((o * BAND_SLOPE) / d + 1)) * d;
  return x > hi ? hi + band(x - hi) : x < lo ? lo - band(lo - x) : x;
}

/** rubberBand undone: what the fingers asked for behind a stretched value, so a new gesture goes on from there. */
export function unrubberBand(x: number, lo: number, hi: number, d = RUBBER): number {
  // The band, b = (1 - 1 / (BAND_SLOPE o / d + 1)) d, solved for the overshoot o.
  const unband = (b: number) => (d / BAND_SLOPE) * (1 / (1 - Math.min(b, d * 0.999) / d) - 1);
  return x > hi ? hi + unband(x - hi) : x < lo ? lo - unband(lo - x) : x;
}

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

/** Release velocity is fitted over this much of the gesture's end (ms). */
export const VELOCITY_WINDOW = 100;
/** Lifted this long (ms) after the last move, the pointer had stopped: no fling. */
export const STOP_MS = 50;

/**
 * The last pointer samples of a gesture in a fixed ring (no allocation per
 * move), and the release velocity fitted to them: a weighted least-squares
 * line through the last VELOCITY_WINDOW ms, newer samples counting up to
 * twice as much as the oldest. A fit over every coalesced sample does not
 * jump with the one noisy sample a two-point estimate would hang on.
 */
export class SampleRing {
  private readonly buf: Float64Array;
  private head = 0;
  private n = 0;
  constructor(private readonly cap = 32) {
    this.buf = new Float64Array(cap * 3);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  push(x: number, y: number, t: number): void {
    const o = this.head * 3;
    this.buf[o] = x;
    this.buf[o + 1] = y;
    this.buf[o + 2] = t;
    this.head = (this.head + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }

  /** The `i`th newest sample's field (0 x, 1 y, 2 t). */
  private at(i: number, f: number): number {
    return this.buf[((this.head - 1 - i + this.cap * 2) % this.cap) * 3 + f]!;
  }

  /**
   * Release velocity in px/s (per second of whatever x and y are). Lifted at
   * `at` (the release's time stamp) more than STOP_MS after the last move,
   * the pointer had stopped: no velocity.
   */
  velocity(at?: number): [number, number] {
    if (this.n === 0) return [0, 0];
    const tl = this.at(0, 2);
    if (at !== undefined && at - tl > STOP_MS) return [0, 0];
    // Weighted means, then the weighted slope, in one pass each.
    let sw = 0;
    let st = 0;
    let sx = 0;
    let sy = 0;
    let m = 0;
    for (; m < this.n; m++) {
      const age = tl - this.at(m, 2);
      if (age > VELOCITY_WINDOW) break;
      const w = 1 - (0.5 * age) / VELOCITY_WINDOW;
      sw += w;
      st += w * age;
      sx += w * this.at(m, 0);
      sy += w * this.at(m, 1);
    }
    if (m < 2) return [0, 0];
    const mt = st / sw;
    const mx = sx / sw;
    const my = sy / sw;
    let stt = 0;
    let stx = 0;
    let sty = 0;
    for (let i = 0; i < m; i++) {
      const age = tl - this.at(i, 2);
      const w = 1 - (0.5 * age) / VELOCITY_WINDOW;
      // Time runs backwards with age: the slope over -age is the velocity.
      const dt = mt - age;
      stt += w * dt * dt;
      stx += w * dt * (this.at(i, 0) - mx);
      sty += w * dt * (this.at(i, 1) - my);
    }
    if (stt <= 0) return [0, 0];
    return [(stx / stt) * 1000, (sty / stt) * 1000];
  }
}

/**
 * How far a fling released at (vx, vy) px/s travels before it comes to rest
 * (below REST_SPEED): exponential decay keeps its direction and has a closed
 * form, so the landing point is known the moment the finger lifts.
 */
export function flingOffset(vx: number, vy: number, rate = DECELERATION, rest = REST_SPEED): [number, number] {
  const sp = Math.hypot(vx, vy);
  if (sp <= rest) return [0, 0];
  const k = (1 - rest / sp) / (-1000 * Math.log(rate));
  return [vx * k, vy * k];
}

/** The same for a pinch's zoom momentum (log scale per second): the log zoom it still adds. */
export function zoomFlingOffset(v: number, rate = ZOOM_DECELERATION, rest = ZOOM_REST): number {
  return flingOffset(v, 0, rate, rest)[0];
}

/** How far past the world's edge a pan can stretch at most, in CSS px. */
export const EDGE_RUBBER = 72;

interface Centred {
  cx: number;
  cz: number;
  /** CSS px per metre. */
  scale: number;
}

/**
 * A view whose centre may stretch past a disc of `radius` metres, ever more
 * stiffly and never more than EDGE_RUBBER px: a pan or a fling into the
 * world's edge gives a little and springs back instead of stopping dead.
 */
export function bandCentre<V extends Centred>(v: V, radius: number): V {
  return bandRadial(v, radius, (o) => rubberBand(o, -Infinity, 0, EDGE_RUBBER));
}

/** The centre the finger asked for behind a banded one (bandCentre undone): a pan goes on from there. */
export function unbandCentre<V extends Centred>(v: V, radius: number): V {
  return bandRadial(v, radius, (o) => unrubberBand(o, -Infinity, 0, EDGE_RUBBER));
}

/**
 * A centre past a disc of `radius` metres shown stretched by `f`, a function
 * of the overshoot in CSS px: bandCentre and unbandCentre.
 */
function bandRadial<V extends Centred>(v: V, radius: number, f: (o: number) => number): V {
  const r = Math.hypot(v.cx, v.cz) * v.scale;
  const edge = radius * v.scale;
  if (r <= edge) return v;
  const k = (edge + f(r - edge)) / r;
  return { ...v, cx: v.cx * k, cz: v.cz * k };
}

/**
 * A velocity (world units per second) carried across the world's edge by a
 * view whose centre is past it (unstretched): the part straight out is sped
 * up behind the stretch by as much as bandCentre slows it there, so the
 * stretch that shows keeps the speed the map had.
 */
export function intoBand(v: Centred, vx: number, vz: number, radius: number): [number, number] {
  const r = Math.hypot(v.cx, v.cz);
  const out = r > 0 ? (vx * v.cx + vz * v.cz) / r : 0;
  if (out <= 0) return [vx, vz];
  // bandCentre's slope at this overshoot (BAND_SLOPE at the edge itself).
  const o = Math.max(0, r - radius) * v.scale;
  const slope = BAND_SLOPE / ((BAND_SLOPE * o) / EDGE_RUBBER + 1) ** 2;
  const k = (out * (1 / slope - 1)) / r;
  return [vx + v.cx * k, vz + v.cz * k];
}

/** A spring back to a limit (the world's edge, the closest or farthest zoom) settles in about this many seconds. */
export const BACK_RESPONSE = 0.3;

/** A glide in flight: where it settles (a world centre and a log scale) and its speed on each (per second). */
export interface Glide {
  cx: number;
  cz: number;
  ls: number;
  v: [number, number, number];
  /** A spring back to the limits: settles in BACK_RESPONSE, a little quicker than a move the user asked for. */
  back?: boolean;
}

/** A glide from where it is now to `target`, at velocity `v`. */
export function toGlide(target: Centred, v: [number, number, number], back = false): Glide {
  return { cx: target.cx, cz: target.cz, ls: Math.log(target.scale), v, back };
}

/**
 * The spring back for a fling that has run past the world's edge at `v`
 * (unstretched) with velocity (vx, vz) in world units per second: back to
 * the edge, and on along it as far as a spring from that speed comes to rest
 * on its own, so the run along the edge slows down instead of sliding back.
 */
export function bounceGlide(v: Centred, vx: number, vz: number, radius: number): Glide {
  const r = Math.hypot(v.cx, v.cz) || 1;
  const out = (vx * v.cx + vz * v.cz) / r;
  const w = (2 * Math.PI) / BACK_RESPONSE;
  // A critically damped spring that starts on its target at speed u comes to rest u / w further on.
  const cx = v.cx + (vx - (out * v.cx) / r) / w;
  const cz = v.cz + (vz - (out * v.cz) / r) / w;
  const k = Math.min(1, radius / Math.hypot(cx, cz));
  const [gx, gz] = intoBand(v, vx, vz, radius);
  return toGlide({ cx: cx * k, cz: cz * k, scale: v.scale }, [gx, gz, 0], true);
}

/** Where a glide settles, as a view. */
export function glideTarget<V extends Centred>(v: V, gl: Glide): V {
  return { ...v, cx: gl.cx, cz: gl.cz, scale: Math.exp(gl.ls) };
}

/**
 * One frame of a glide: the centre and the log scale each on their own
 * critically damped spring towards the glide's target. Past the world's edge
 * the centre is shown stretched (bandCentre, as under a panning finger), so a
 * glide back from there, or a fling that ran into the edge, gives and springs
 * back. The spring runs on the centre behind the stretch, and the stretch is
 * applied once for show: stretching the stretched centre again would squeeze
 * the overshoot away in a few frames (#125). `gl.v` is updated in place.
 * `done`: it has settled, and `view` is exactly the target.
 */
export function glideStep<V extends Centred>(v: V, gl: Glide, dtSec: number, radius: number): { view: V; done: boolean } {
  const response = gl.back ? BACK_RESPONSE : 0.4;
  const u = unbandCentre(v, radius);
  const sx = springStep(u.cx, gl.v[0], gl.cx, dtSec, response);
  const sz = springStep(u.cz, gl.v[1], gl.cz, dtSec, response);
  const ss = springStep(Math.log(v.scale), gl.v[2], gl.ls, dtSec, response);
  gl.v[0] = sx.v;
  gl.v[1] = sz.v;
  gl.v[2] = ss.v;
  // Close and slow: a fling that has only just crossed the edge is close to its target too, but on its way out.
  const done = Math.abs(sx.x - gl.cx) * v.scale < 0.3 && Math.abs(sz.x - gl.cz) * v.scale < 0.3 && Math.abs(ss.x - gl.ls) < 0.002 && Math.hypot(sx.v, sz.v) * v.scale < REST_SPEED && Math.abs(ss.v) < ZOOM_REST;
  if (done) return { view: glideTarget(v, gl), done };
  return { view: bandCentre({ ...v, cx: sx.x, cz: sz.x, scale: Math.exp(ss.x) }, radius), done };
}
