// The woods (and terrain edits) of the WebGL map, drawn chunk by chunk off
// the main thread on an OffscreenCanvas (see woodsworker.ts). It keeps its
// own copy of the loaded nature, sent as it changes, builds every chunk's
// paths when first drawn (no time budget here: nothing waits on this
// thread but the woods), and answers each draw with premultiplied pixels,
// transferred. The first message asks whether this browser can draw here
// at all.

import { unpackNature, type NatureItem, type PackedNature } from "./nature";
import { NatureLayer } from "./naturerender";
import type { TileRef } from "./terraintiles";
import { CHUNK, drawUnderFog, rasterChunk, type HeatSpot } from "./woodsraster";

export type WoodsRequest =
  | { type: "probe" }
  | { type: "nature"; add: [string, PackedNature][]; drop: string[] }
  | { type: "heat"; spots: HeatSpot[] }
  | { type: "draw"; id: number; t: TileRef; R: number; k: number; at: number; woods: boolean; heat: boolean; layers: { nature: boolean; pickables: boolean } };

export type WoodsReply = { type: "probe"; ok: boolean } | { type: "px"; id: number; px: Uint8ClampedArray<ArrayBuffer> | null };

const nature = new NatureLayer(Infinity);
const loaded = new Map<string, readonly NatureItem[]>();
let spots: HeatSpot[] = [];
let canvas: OffscreenCanvas | null = null;

const reply = (m: WoodsReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

/** Everything a draw needs is here: a 2D OffscreenCanvas, Path2D (nature's shapes) and DOMMatrix (the woods' wash). */
function probe(): boolean {
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof Path2D === "undefined" || typeof DOMMatrix === "undefined") return false;
    const g = new OffscreenCanvas(1, 1).getContext("2d");
    if (!g) return false;
    g.fill(new Path2D("M0 0h1v1h-1z"));
    return g.getImageData(0, 0, 1, 1).data[3] === 255;
  } catch {
    return false;
  }
}

self.onmessage = (e: MessageEvent<WoodsRequest>) => {
  const m = e.data;
  switch (m.type) {
    case "probe":
      reply({ type: "probe", ok: probe() });
      break;
    case "nature":
      for (const k of m.drop) loaded.delete(k);
      for (const [k, p] of m.add) loaded.set(k, unpackNature(p));
      nature.set(new Map(loaded));
      break;
    case "heat":
      spots = m.spots;
      break;
    case "draw": {
      let px: Uint8ClampedArray<ArrayBuffer> | null = null;
      try {
        canvas ??= new OffscreenCanvas(CHUNK, CHUNK);
        const g = canvas.getContext("2d", { willReadFrequently: true });
        if (g)
          px = rasterChunk(g, m.t, m.R, m.k, (c, box, scale) => drawUnderFog(c, box, scale, { heat: m.heat ? spots : null, nature: m.woods ? nature : null, layers: m.layers, at: m.at }));
      } catch {
        px = null;
      }
      reply({ type: "px", id: m.id, px }, px ? [px.buffer] : []);
      break;
    }
  }
};
