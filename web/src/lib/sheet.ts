// Drag-to-dismiss math for the profile sheet. Pure functions, so they can be
// tested without a browser. Offsets are measured along the dismiss axis:
// 0 is fully open, `size` is fully off-screen, negative is past the open edge.

/**
 * Where a released gesture would come to rest if it kept decelerating like a
 * scroll view (the exponential-decay projection from Apple's fluid interfaces
 * sample code). `velocity` in px/s, result in px.
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Progressive resistance past a boundary: follows less the further it goes, never stops dead. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Inverse of `rubberband` for positive overshoot: how far the pointer went to produce `stretched`. */
export function unrubberband(stretched: number, dimension: number, constant = 0.55): number {
  const r = Math.abs(stretched);
  if (dimension <= 0 || r === 0) return 0;
  const travel = (r * dimension) / (constant * Math.max(1e-9, dimension - r));
  return Math.sign(stretched) * travel;
}

/** Pointer travel to sheet offset: 1:1 toward dismiss, rubber-banded past the open edge. */
export function dragOffset(travel: number, size: number): number {
  return travel >= 0 ? travel : -rubberband(-travel, size);
}

/** Sheet offset back to pointer travel, so a sheet grabbed mid-flight continues from where it is. */
export function travelFor(offset: number, size: number): number {
  return offset >= 0 ? offset : -unrubberband(-offset, size);
}

export interface Sample {
  /** Position along the dismiss axis, px. */
  p: number;
  /** Timestamp, ms. */
  t: number;
}

/** Samples older than this (relative to the newest) do not count toward release velocity. */
export const VELOCITY_WINDOW_MS = 100;

/** Release velocity in px/s from the recent pointer history; 0 when there is too little to tell. */
export function velocityFrom(samples: readonly Sample[]): number {
  const last = samples.at(-1);
  if (!last) return 0;
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (last.t - s.t > VELOCITY_WINDOW_MS) break;
    first = s;
  }
  const dt = last.t - first.t;
  return dt > 0 ? ((last.p - first.p) / dt) * 1000 : 0;
}

/** Above this speed the direction of the flick decides, whatever the position. */
export const FLICK_VELOCITY = 300;

/**
 * Commit (dismiss) or reverse (snap back open) at release. A real flick is
 * decided by the sign of its velocity; a slow release by where its projected
 * resting point lands relative to the halfway mark.
 */
export function shouldDismiss(offset: number, velocity: number, size: number): boolean {
  if (Math.abs(velocity) >= FLICK_VELOCITY) return velocity > 0;
  return offset + project(velocity) > size / 2;
}
