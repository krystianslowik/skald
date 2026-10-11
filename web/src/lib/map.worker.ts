// The land and fog shapes of a map snapshot, and the first time the paper
// textures, built off the main thread (see mapShapes, paper.ts): answers
// with plain arrays, transferred, or an error string.

import { mapShapes, shapeBuffers } from "./mapgeo";
import { textures } from "./paper";
import type { MapExplored, MapLand } from "../types";

self.onmessage = (e: MessageEvent<{ land: MapLand; explored: MapExplored; textures: boolean }>) => {
  try {
    const shapes = mapShapes(e.data.land, e.data.explored);
    const tex = e.data.textures ? textures() : undefined;
    postMessage({ shapes, textures: tex }, { transfer: [...shapeBuffers(shapes), ...(tex ? [tex.paper.buffer, tex.clouds.buffer] : [])] });
  } catch (err) {
    postMessage({ error: String(err) });
  }
};
