// Drawing one chunk of what the WebGL map lays over its terrain (woods and
// terrain edits, floor plans) on a Canvas2D context, the same on the main
// thread (mapgl.ts) and in the woods worker (woods.worker.ts), so both give
// the same pixels for the same chunk.

import { padBox, premultiply } from "./gltiles";
import type { NatureLayer } from "./naturerender";
import type { TileRef } from "./terraintiles";

/** Woods and floor plans are rasterized in chunks of this many pixels a side. */
export const CHUNK = 256;

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export type HeatSpot = { x: number; z: number; cells: number };

/** What a chunk under the fog shows: terrain edits (`heat`, or null) and nature (null for none), styled for zoom `at`. */
export interface UnderFog {
  heat: readonly HeatSpot[] | null;
  nature: NatureLayer | null;
  layers: { nature: boolean; pickables: boolean };
  at: number;
  /** How far the woods are drawn as a canopy (0..1, see NatureLayer.draw). */
  canopy: number;
}

/** A chunk under the fog, as rasterChunk's `draw`: terrain edits, then nature over them. */
export function drawUnderFog(g: Ctx, box: readonly [number, number, number, number], scale: number, o: UnderFog): void {
  if (o.heat) drawHeat(g, o.heat);
  o.nature?.draw(g, padBox(box), scale, o.layers, false, o.at, o.canopy);
}

/** A chunk's world box (west, south, east, north) and its pixels per metre, in a world of radius `R`. */
export function chunkFrame(t: TileRef, R: number): { box: [number, number, number, number]; s: number } {
  const span = (2 * R) / 2 ** t.z;
  const west = -R + t.x * span;
  const north = R - t.y * span;
  return { box: [west, north - span, west + span, north], s: CHUNK / span };
}

/**
 * Draws chunk `t` on `g` (a CHUNK square, world north-west at its top left,
 * clipped to the world's disc) and returns its premultiplied pixels. `draw`
 * gets the world transform, the chunk's box and its own scale in CSS px per
 * metre for a device pixel ratio of `k`.
 */
export function rasterChunk(g: Ctx, t: TileRef, R: number, k: number, draw: (g: Ctx, box: readonly [number, number, number, number], scale: number) => void): Uint8ClampedArray<ArrayBuffer> {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, CHUNK, CHUNK);
  const { box, s } = chunkFrame(t, R);
  g.setTransform(s, 0, 0, -s, -box[0] * s, box[3] * s);
  g.save();
  g.beginPath();
  g.arc(0, 0, R, 0, Math.PI * 2);
  g.clip();
  draw(g, box, s / k);
  g.restore();
  return premultiply(g.getImageData(0, 0, CHUNK, CHUNK).data as Uint8ClampedArray<ArrayBuffer>);
}

/** Where the ground was dug or raised, as warm glows: one per edited spot. */
export function drawHeat(g: Ctx, spots: readonly HeatSpot[]): void {
  for (const e of spots) {
    const r = 46;
    const a = Math.min(0.75, 0.12 + Math.log2(1 + e.cells) / 16);
    const grad = g.createRadialGradient(e.x, e.z, 0, e.x, e.z, r);
    grad.addColorStop(0, `rgba(196, 70, 22, ${a})`);
    grad.addColorStop(1, "rgba(196, 70, 22, 0)");
    g.fillStyle = grad;
    g.fillRect(e.x - r, e.z - r, r * 2, r * 2);
  }
}
