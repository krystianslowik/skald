// The coast of the terrain image, traced off the main thread: a 2048 px image
// is four million cells, too many to walk between frames on a phone. Takes
// the decoded image, answers with the land outline in grid units (column,
// row from the south), or no loops where there is no OffscreenCanvas.

import { gridOutline, isWater } from "./mapgeo";

self.onmessage = (e: MessageEvent<{ bitmap: ImageBitmap }>) => {
  const { bitmap } = e.data;
  const w = bitmap.width;
  const h = bitmap.height;
  let loops: Float32Array[] = [];
  try {
    const g = new OffscreenCanvas(w, h).getContext("2d");
    if (g) {
      g.drawImage(bitmap, 0, 0);
      const px = g.getImageData(0, 0, w, h).data;
      const land = new Float32Array(w * h);
      // Image rows run north to south, grid rows south to north.
      for (let row = 0; row < h; row++) {
        const j = (h - 1 - row) * w;
        for (let col = 0; col < w; col++) {
          const o = (row * w + col) * 4;
          land[j + col] = isWater(px[o]!, px[o + 1]!, px[o + 2]!, px[o + 3]!) ? 0 : 1;
        }
      }
      loops = gridOutline(land, w, h);
    }
  } catch {
    // no 2D canvas in workers here: no coast
  }
  bitmap.close();
  postMessage({ w, h, loops }, { transfer: loops.map((l) => l.buffer) });
};
