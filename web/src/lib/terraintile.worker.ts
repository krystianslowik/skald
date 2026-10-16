// Fetches, ungzips, decodes and paints terrain tiles off the main thread and
// answers with an ImageBitmap, transferred. One worker serves the map; the
// main thread only schedules (terraintiles.ts) and draws the bitmaps.

import { decodeTile, paintTile, type Palette } from "./terrainpaint";

type Load = { type: "load"; key: string; url: string; low?: boolean; factor: number; palette: Palette; waterLevel: number; radius: number; apron: number };
type Cancel = { type: "cancel"; key: string };

const inflight = new Map<string, AbortController>();

async function gunzip(res: Response): Promise<ArrayBuffer> {
  const body = res.body!.pipeThrough(new DecompressionStream("gzip"));
  return new Response(body).arrayBuffer();
}

async function load(m: Load) {
  const ac = new AbortController();
  inflight.set(m.key, ac);
  try {
    const res = await fetch(m.url, { credentials: "same-origin", signal: ac.signal, priority: m.low ? "low" : "auto" });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      postMessage({ key: m.key, status: res.status });
      return;
    }
    const raw = await gunzip(res);
    if (ac.signal.aborted) return;
    const t0 = performance.now();
    const tile = decodeTile(raw);
    const px = paintTile(tile, { factor: m.factor, palette: m.palette, waterLevel: m.waterLevel, radius: m.radius, apron: m.apron });
    const size = (tile.n - 2 * m.apron) * m.factor;
    const canvas = new OffscreenCanvas(size, size);
    const g = canvas.getContext("2d");
    if (!g) throw new Error("no 2D context in the worker");
    g.putImageData(new ImageData(px, size, size), 0, 0);
    const bitmap = canvas.transferToImageBitmap();
    postMessage({ key: m.key, bitmap, paintMs: performance.now() - t0 }, { transfer: [bitmap] });
  } catch (err) {
    if (!ac.signal.aborted) postMessage({ key: m.key, status: 0, error: String(err) });
  } finally {
    inflight.delete(m.key);
  }
}

self.onmessage = (e: MessageEvent<Load | Cancel>) => {
  const m = e.data;
  if (m.type === "cancel") inflight.get(m.key)?.abort();
  else void load(m);
};
