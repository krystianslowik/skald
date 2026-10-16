// The land and fog shapes of a map snapshot, and the first time the paper
// textures, built off the main thread (see mapShapes, paper.ts); for the
// WebGL map also the fog's distance field and the generated-zone mask
// (fogfield.ts). Answers with plain arrays, transferred, or an error string.

import { fogField, seaMask } from "./fogfield";
import { mapShapes, shapeBuffers } from "./mapgeo";
import { textures } from "./paper";
import type { MapExplored, MapLand } from "../types";

self.onmessage = (e: MessageEvent<{ land: MapLand; explored: MapExplored; textures: boolean; gl?: boolean }>) => {
  try {
    const shapes = mapShapes(e.data.land, e.data.explored);
    const tex = e.data.textures ? textures() : undefined;
    const fields = e.data.gl ? { fog: shapes.fog ? fogField(shapes.fog, shapes.fogStep) : null, sea: seaMask(e.data.land) } : undefined;
    const buffers = [...shapeBuffers(shapes), ...(tex ? [tex.paper.buffer, tex.clouds.buffer] : []), ...(fields ? [fields.sea.data.buffer, ...(fields.fog ? [fields.fog.data.buffer] : [])] : [])];
    postMessage({ shapes, textures: tex, fields }, { transfer: buffers });
  } catch (err) {
    postMessage({ error: String(err) });
  }
};
