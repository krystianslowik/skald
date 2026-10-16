// Fetches, ungzips and decodes terrain tiles for the WebGL map and answers
// with the packed texture data (packTile), transferred. No painting: the GPU
// shades the tiles. A few of these run side by side (terraindata.ts).

import { decodeTile, packTile } from "./terrainpaint";

type Load = { type: "load"; key: string; url: string; edge: number; meanForest: number[] };
type Cancel = { type: "cancel"; key: string };

const inflight = new Map<string, AbortController>();

async function load(m: Load) {
  const ac = new AbortController();
  inflight.set(m.key, ac);
  try {
    const res = await fetch(m.url, { credentials: "same-origin", signal: ac.signal });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      postMessage({ key: m.key, status: res.status });
      return;
    }
    const raw = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    if (ac.signal.aborted) return;
    const tile = decodeTile(raw);
    if (tile.n !== m.edge) throw new Error(`terrain tile of ${tile.n} samples, want ${m.edge}`);
    const data = packTile(tile, m.meanForest);
    postMessage({ key: m.key, data }, { transfer: [data.buffer] });
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
