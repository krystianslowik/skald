// The world map's terrain on the GPU (WebGL2): tiles are uploaded as raw
// data (biome, forest, height per sample, see packTile) into one fixed
// texture array, and a fragment shader shades them per screen pixel exactly
// as paintTile does on the CPU, so a place has one colour at every zoom.
// Paper, the fog of war and the world's edge are drawn in full-screen passes
// from small textures. The woods and floor plans, which only Canvas2D can
// draw (maprender.ts), are rasterized in small world-anchored chunks a few
// at a time, kept in a second texture array and composited between them, so
// no frame ever re-rasterizes a whole layer. Which tiles and chunks a view
// needs, and which loaded relatives stand in for missing ones, is planned by
// terraintiles.ts (planView, the same as the Canvas2D map); arrivals and
// level changes crossfade (gltiles.ts). A frame only uploads or rasterizes a
// few pieces and draws. maprender.ts falls back to its Canvas2D renderer
// without WebGL2 or while the context is lost.

import { Fades, FADE_MS, GPU_PIN_LEVEL, heldLevel, slotQuads, subRect, TexturePool, UploadBudget, type Quad } from "./gltiles";
import type { FogField, SeaMask } from "./fogfield";
import { COAST, PAPER, PAPER_DARK, PAPER_INK, VOID, type Textures } from "./paper";
import type { TileFeed } from "./terraindata";
import { FOREST_DARKEN, paletteOf, RELIEF, SWAMP, WATER_DEEP, WATER_SHALLOW } from "./terrainpaint";
import { pinnedTiles, planView, tileKey, type TileRef, type TilesDoc } from "./terraintiles";
import type { View } from "./mapgeo";

/** The most device pixels per CSS pixel the terrain is drawn at: finer than the data on any phone, and a third of the fill on a 3x screen. */
const MAX_DPR = 2;
/** The most pixels the drawing buffer may have (Safari refuses bigger canvases). */
const MAX_PIXELS = 16_000_000;
const FLOATS = 16;
/** Woods and floor plans are rasterized in chunks of this many pixels a side. */
const CHUNK = 256;
/** Chunk levels: the finest has a chunk pixel at about 2 cm, a device pixel at the closest zoom. */
const CHUNK_LEVELS = 13;
/** Time a frame may spend rasterizing chunks (at least one is always done). */
const CHUNK_MS = 6;
/** The tile edge the shader is built for (tileSize 256 plus a two-sample apron each side), as the agent serves. */
export const TILE_EDGE = 260;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
const vec3 = (c: readonly number[]) => `vec3(${c.map((x) => x.toFixed(5)).join(", ")})`;
const f = (x: number) => x.toFixed(5);

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2DArray;
`;

/** Shared by the tile and sheet passes: coverage of the world disc and of the generated zones. */
const COMMON = `
uniform float uRadius;
uniform int uSeaOn;
uniform vec4 uSea;
uniform sampler2D uSeaTex;
float discCov(vec2 w, float pxPerM) { return clamp(0.5 + (uRadius - length(w)) * pxPerM, 0.0, 1.0); }
float seaCov(vec2 w) {
  vec2 uv = ((w - uSea.xx) / uSea.y + 0.5) / uSea.z;
  float m = texture(uSeaTex, uv).r;
  float fw = max(fwidth(m), 1e-4);
  float inside = step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
  return uSeaOn == 0 ? 1.0 : inside * clamp(0.5 + (m - 0.5) / fw, 0.0, 1.0);
}
`;

const TILE_VS = `${HEADER}
layout(location = 0) in vec4 aScreen;
layout(location = 1) in vec4 aWorld;
layout(location = 2) in vec4 aSample;
layout(location = 3) in vec4 aMisc;
out vec2 vWorld;
out vec2 vSample;
flat out vec3 vMisc;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  gl_Position = vec4(mix(aScreen.xy, aScreen.zw, c), 0.0, 1.0);
  vWorld = mix(aWorld.xy, aWorld.zw, c);
  vSample = mix(aSample.xy, aSample.zw, c);
  vMisc = aMisc.xyz;
}`;

/**
 * paintTile, per pixel. Each pixel reads the 4 x 4 samples round it: heights
 * bilinear (coasts are smooth curves), hillshade from centred differences at
 * the four nearest samples, forest under a quadratic B-spline, and near a
 * biome border the biome with the most weight under that spline, blended
 * with the runner-up over about 1.6 device px.
 */
const TILE_FS = `${HEADER}
${COMMON}
uniform highp usampler2DArray uTiles;
uniform vec3 uPal[16];
uniform int uPalN;
uniform float uWater;
uniform float uPxPerM;
in vec2 vWorld;
in vec2 vSample;
flat in vec3 vMisc;
out vec4 outColor;

vec4 spline(float t) {
  vec4 w;
  for (int k = 0; k < 4; k++) {
    float d = abs(float(k) - 1.0 - t);
    w[k] = d < 0.5 ? 0.75 - d * d : d < 1.5 ? 0.5 * (1.5 - d) * (1.5 - d) : 0.0;
  }
  return w;
}
vec3 biomeRgb(uint b, float shade) {
  int i = int(b) < uPalN ? int(b) : 0;
  return uPal[i] * vec3(0.94, 1.0, 0.9) * shade;
}

void main() {
  vec2 s = vSample;
  // Samples per device pixel, for the anti-aliased biome edge; and the generated-zone clip (both before any branch).
  float spp = max(length(dFdx(s)), length(dFdy(s)));
  float cov = vMisc.y * discCov(vWorld, uPxPerM) * seaCov(vWorld);
  ivec2 b = clamp(ivec2(floor(s)), ivec2(1), ivec2(${TILE_EDGE - 3}));
  vec2 fr = clamp(s - vec2(b), 0.0, 1.0);
  int layer = int(vMisc.x + 0.5);
  float stepM = vMisc.z;
  uint bio[16];
  float hgt[16];
  float fo[16];
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      uvec4 t = texelFetch(uTiles, ivec3(b.x - 1 + i, b.y - 1 + j, layer), 0);
      int k = j * 4 + i;
      bio[k] = t.r;
      fo[k] = float(t.g) / 255.0;
      hgt[k] = float(t.b * 256u + t.a) / 50.0 - 500.0;
    }
  }
  // Hillshade at the four nearest samples: light from the north-west, 45 degrees up.
  vec4 sh;
  vec4 hb;
  for (int q = 0; q < 4; q++) {
    int i = 1 + (q & 1);
    int j = 1 + (q >> 1);
    float dhdx = (hgt[j * 4 + i + 1] - hgt[j * 4 + i - 1]) / (2.0 * stepM);
    float dhdz = (hgt[(j - 1) * 4 + i] - hgt[(j + 1) * 4 + i]) / (2.0 * stepM);
    float nx = -dhdx * ${f(RELIEF)};
    float nz = -dhdz * ${f(RELIEF)};
    float lit = (nx * -0.5 + nz * 0.5 + 0.70711) / sqrt(nx * nx + nz * nz + 1.0) / 0.70711;
    sh[q] = clamp(1.0 + (lit - 1.0) * 0.85, 0.58, 1.22);
    hb[q] = hgt[j * 4 + i];
  }
  vec4 w = vec4((1.0 - fr.x) * (1.0 - fr.y), fr.x * (1.0 - fr.y), (1.0 - fr.x) * fr.y, fr.x * fr.y);
  float shade = dot(w, sh);
  float hh = dot(w, hb);
  vec4 kx = spline(fr.x);
  vec4 kz = spline(fr.y);
  float W[16];
  float forest = 0.0;
  bool same = true;
  for (int k = 0; k < 16; k++) {
    W[k] = kz[k >> 2] * kx[k & 3];
    forest += W[k] * fo[k];
    same = same && bio[k] == bio[0];
  }
  uint best = bio[0];
  vec3 c;
  if (same) {
    c = biomeRgb(best, shade);
  } else {
    // Each biome's weight under the spline (up to four biomes round a pixel;
    // a fifth is too faint to matter); the heaviest wins, ties to the lower index.
    uint bb[4];
    float bwt[4];
    int nb = 0;
    for (int k = 0; k < 16; k++) {
      bool hit = false;
      for (int m = 0; m < 4; m++) {
        if (m < nb && bb[m] == bio[k]) {
          bwt[m] += W[k];
          hit = true;
        }
      }
      if (!hit && nb < 4) {
        bb[nb] = bio[k];
        bwt[nb] = W[k];
        nb++;
      }
    }
    float bw = -1.0;
    float sw = -1.0;
    uint second = 0u;
    for (int m = 0; m < 4; m++) {
      if (m >= nb) break;
      uint bk = bb[m];
      float wk = bwt[m];
      if (wk > bw || (wk == bw && bk < best)) {
        if (bw >= 0.0) {
          second = best;
          sw = bw;
        }
        best = bk;
        bw = wk;
      } else if (wk > sw || (wk == sw && bk < second)) {
        second = bk;
        sw = wk;
      }
    }
    c = biomeRgb(best, shade);
    if (sw > 0.0) {
      float k = 0.5 + 0.5 * smoothstep(0.0, 1.6 * spp, bw - sw);
      c = mix(biomeRgb(second, shade), c, k);
    }
  }
  c *= 1.0 - ${f(FOREST_DARKEN)} * forest;
  float depth = uWater - hh;
  if (depth > 0.0) {
    float a = best == ${SWAMP}u ? max(0.55 * smoothstep(0.0, 3.0, depth), smoothstep(3.0, 8.0, depth)) : smoothstep(0.0, 0.8, depth);
    vec3 water = mix(${vec3(WATER_SHALLOW.map((x) => x / 255))}, ${vec3(WATER_DEEP.map((x) => x / 255))}, smoothstep(2.0, 70.0, depth));
    c += (water - c) * a;
  }
  outColor = vec4(clamp(c, 0.0, 1.0) * cov, cov);
}`;

const SHEET_VS = `${HEADER}
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID >> 1) * 4 - 1));
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/**
 * The full-screen passes. Mode 0: the night round the world and the
 * parchment with its grain. Mode 1: the grain again, lightly, over the
 * terrain. Mode 2: the fog (cloud paper, with a soft rim on the explored
 * side a fixed few screen px wide) and the world's edge.
 */
const SHEET_FS = `${HEADER}
${COMMON}
uniform int uMode;
uniform vec4 uView;
uniform vec2 uHalf;
uniform vec4 uPaperOct;
uniform vec4 uPaperOff;
uniform vec4 uCloudOct;
uniform vec4 uCloudOff;
uniform float uPaperAlpha;
uniform int uFog;
uniform vec4 uFogBox;
uniform float uRim;
uniform sampler2D uPaper;
uniform sampler2D uClouds;
uniform sampler2D uFogTex;
out vec4 outColor;

vec4 over(vec4 dst, vec3 c, float a) { return vec4(c * a + dst.rgb * (1.0 - a), a + dst.a * (1.0 - a)); }
vec4 paperOver(vec4 acc, vec2 rel, float alpha) {
  float t0 = texture(uPaper, uPaperOff.xy + rel / uPaperOct.x).r;
  float t1 = texture(uPaper, uPaperOff.zw + rel / uPaperOct.y).r;
  acc = over(acc, ${vec3(PAPER_INK.map((x) => x / 255))}, t0 * uPaperOct.z * alpha);
  return over(acc, ${vec3(PAPER_INK.map((x) => x / 255))}, t1 * uPaperOct.w * alpha);
}

void main() {
  float pxPerM = uView.z;
  vec2 rel = (gl_FragCoord.xy - uHalf) / pxPerM;
  vec2 w = uView.xy + rel;
  float disc = discCov(w, pxPerM);
  if (uMode == 0) {
    vec4 paper = paperOver(vec4(${vec3(rgb(PAPER))}, 1.0), rel, uPaperAlpha);
    outColor = vec4(mix(${vec3(rgb(VOID))}, paper.rgb, disc), 1.0);
    return;
  }
  if (uMode == 1) {
    outColor = paperOver(vec4(0.0), rel, uPaperAlpha) * disc * seaCov(w);
    return;
  }
  vec4 acc = vec4(0.0);
  if (uFog > 0) {
    vec2 fuv = (w - uFogBox.xy) / uFogBox.zw;
    float fd = texture(uFogTex, fuv).r;
    vec3 cloud0 = texture(uClouds, uCloudOff.xy + rel / uCloudOct.x).rgb;
    vec3 cloud1 = texture(uClouds, uCloudOff.zw + rel / uCloudOct.y).rgb;
    bool inField = uFog == 2 && all(greaterThanEqual(fuv, vec2(0.0))) && all(lessThanEqual(fuv, vec2(1.0)));
    float d = inField ? fd : 1e5;
    float into = clamp(0.5 + d * pxPerM, 0.0, 1.0);
    // The rim: six bands of cloud at 0.1 each, the widest uRim screen px across the edge.
    float css = -d * pxPerM / uView.w;
    float n = clamp(6.0 - 12.0 * css / uRim, 0.0, 6.0);
    float rimA = (1.0 - pow(0.9, n)) * (1.0 - into) * disc;
    acc = vec4(cloud0 * rimA, rimA);
    vec4 fog = paperOver(vec4(mix(cloud0, cloud1, uCloudOct.w), 1.0), rel, 0.35);
    acc = over(acc, fog.rgb, into * disc);
  }
  // The edge of the world: a wide pale line and a thin dark one on it.
  float dr = abs(length(w) - uRadius) * pxPerM;
  acc = over(acc, ${vec3(rgb(PAPER_DARK))}, clamp(3.0 * uView.w + 0.5 - dr, 0.0, 1.0));
  outColor = over(acc, ${vec3(rgb(COAST))}, clamp(0.75 * uView.w + 0.5 - dr, 0.0, 1.0));
}`;

/** Woods and floor plans: one premultiplied texel per chunk pixel, from the chunk array. */
const RASTER_FS = `${HEADER}
precision highp sampler2DArray;
uniform highp sampler2DArray uChunks;
in vec2 vWorld;
in vec2 vSample;
flat in vec3 vMisc;
out vec4 outColor;
void main() { outColor = texture(uChunks, vec3(vSample, vMisc.x)) * vMisc.y; }`;

export interface GLFrame {
  view: View;
  /** The fog of war layer is on. */
  fog: boolean;
  /** Spoilers on: terrain is not cut to the generated zones. */
  spoilers: boolean;
  /** Frame time (performance.now()). */
  now: number;
}

/** What a frame drew, for tests and profiling. */
export interface GLStats {
  level: number;
  wanted: number;
  quads: number;
  own: number;
  ancestor: number;
  descendant: number;
  blank: number;
  fading: number;
  uploads: number;
  pending: number;
  pool: number;
  capacity: number;
  /** Woods and floor-plan chunks rasterized this frame, and still to do. */
  chunks: number;
  chunksPending: number;
}

/**
 * Something Canvas2D draws over the terrain (woods, floor plans), in world
 * units: `draw` gets a context whose transform maps the world (y up) onto a
 * chunk, the chunk's box, and the zoom (CSS px per metre) to draw for.
 * `gen` names what it shows: a chunk drawn for another gen is redrawn (and
 * shown as it was meanwhile); a change of `kind` drops every chunk at once.
 */
export interface RasterSource {
  kind: string;
  gen: string;
  draw(g: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, box: readonly [number, number, number, number], scale: number): void;
}

type Programs = {
  tile: WebGLProgram;
  sheet: WebGLProgram;
  raster: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
};

interface Res {
  p: Programs;
  vao: WebGLVertexArrayObject;
  empty: WebGLVertexArrayObject;
  inst: WebGLBuffer;
  pool: WebGLTexture | null;
  chunks: WebGLTexture | null;
  paper: WebGLTexture;
  clouds: WebGLTexture;
  fog: WebGLTexture;
  sea: WebGLTexture;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(p) ?? "";
    for (const s of gl.getAttachedShaders(p) ?? []) {
      const msg = gl.getShaderInfoLog(s);
      if (msg) console.error(msg);
    }
    throw new Error(`map shader: ${log}`);
  }
  return p;
}

const deviceMemory = () => (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory ?? 8;

/** Tiles (or chunks) that can be on a screen of pxW x pxH device px at once: samples are at least 0.7 px, so one is at least 180 px across. */
const perScreen = (pxW: number, pxH: number) => (Math.ceil(pxW / 180) + 2) * (Math.ceil(pxH / 180) + 2);

/**
 * How many tiles the GPU keeps (270 KB each): a screen and a half of them
 * plus the pinned levels, within the device's limits. iOS Safari reports no
 * memory size, so a phone's pool is bounded by its screen: about 42 MB.
 */
export function poolCapacity(pxW: number, pxH: number, maxLayers: number, mem = 8): number {
  const want = Math.ceil(1.6 * perScreen(pxW, pxH)) + 21 + 8;
  return Math.max(64, Math.min(maxLayers, mem <= 4 ? 128 : 256, want));
}

/** Chunks of woods and floor plans the GPU keeps (256 KB each): both layers over a screen, about 40 MB on a phone, and only once one is shown. */
export function chunkCapacity(pxW: number, pxH: number, maxLayers: number, mem = 8): number {
  return Math.max(32, Math.min(maxLayers, mem <= 4 ? 112 : 160, 2 * perScreen(pxW, pxH)));
}

const chunkKey = (i: number, t: TileRef) => `${i}:${tileKey(t)}`;

export class GLMap {
  private res: Res | null = null;
  private lost = false;
  private disposed = false;
  private doc: TilesDoc | null = null;
  private feed: TileFeed | null = null;
  private pool: TexturePool | null = null;
  private readonly fades = new Fades();
  private readonly budget = new UploadBudget(3, 3);
  private level: number | undefined;
  private lastUsed: ReadonlySet<string> = new Set();
  /** Tiles the CPU side keeps for good (levels 0..3): the floor, re-uploaded in a frame after a lost context. */
  private pinned: ReadonlySet<string> = new Set();
  private instData = new Float32Array(FLOATS * 64);
  private paperTex: Textures | null = null;
  private fogField: FogField | null | undefined;
  /** Fog everywhere (explored is known, nothing explored yet) when there is no field. */
  private fogAll = false;
  private sea: SeaMask | null = null;
  private rasters: [RasterSource | null, RasterSource | null] = [null, null];
  private chunks: TexturePool | null = null;
  /** The gen each chunk was drawn for. */
  private chunkGen = new Map<string, string>();
  private chunkKind: [string, string] = ["", ""];
  private chunkUsed: ReadonlySet<string> = new Set();
  private chunkLevel: number | undefined;
  private readonly chunkFades = new Fades(FADE_MS);
  private readonly chunkBudget = new UploadBudget(16, CHUNK_MS);
  private scratch: OffscreenCanvas | HTMLCanvasElement | null = null;
  private pal = new Float32Array(48);
  private palN = 1;
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private maxTex = 4096;
  private maxLayers = 256;
  stats: GLStats = { level: 0, wanted: 0, quads: 0, own: 0, ancestor: 0, descendant: 0, blank: 0, fading: 0, uploads: 0, pending: 0, pool: 0, capacity: 0, chunks: 0, chunksPending: 0 };
  /** Called when the context comes back, and when it goes. */
  onRestored: (() => void) | null = null;
  onLost: (() => void) | null = null;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
  ) {
    canvas.addEventListener("webglcontextlost", this.lose);
    canvas.addEventListener("webglcontextrestored", this.restore);
  }

  /** A renderer on `canvas`, or null without WebGL2 (or if its shaders do not build there). */
  static create(canvas: HTMLCanvasElement): GLMap | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    } catch {
      return null;
    }
    if (!gl) return null;
    const m = new GLMap(canvas, gl);
    try {
      m.init();
    } catch (err) {
      console.error(err);
      m.dispose();
      return null;
    }
    return m;
  }

  /** Whether frames can be drawn now (not lost, not disposed). */
  get ready(): boolean {
    return !this.lost && !this.disposed && this.res !== null;
  }

  private lose = (e: Event) => {
    e.preventDefault();
    this.lost = true;
    this.res = null;
    this.forget();
    if (!this.disposed) this.onLost?.();
  };

  private restore = () => {
    if (this.disposed) return;
    try {
      this.init();
    } catch (err) {
      console.error(err);
      return;
    }
    this.lost = false;
    this.onRestored?.();
  };

  /** Everything on the GPU is gone (a lost context): tiles and chunks go up again as frames want them. */
  private forget() {
    this.pool = null;
    this.chunks = null;
    this.chunkGen.clear();
    this.fades.clear();
    this.chunkFades.clear();
  }

  private init() {
    const gl = this.gl;
    const tile = compile(gl, TILE_VS, TILE_FS);
    const sheet = compile(gl, SHEET_VS, SHEET_FS);
    const raster = compile(gl, TILE_VS, RASTER_FS);
    const u: Programs["u"] = {};
    const names: [WebGLProgram, string, string[]][] = [
      [tile, "t.", ["uTiles", "uPal", "uPalN", "uWater", "uPxPerM", "uRadius", "uSeaOn", "uSea", "uSeaTex"]],
      [sheet, "s.", ["uMode", "uView", "uHalf", "uPaperOct", "uPaperOff", "uCloudOct", "uCloudOff", "uPaperAlpha", "uFog", "uFogBox", "uRim", "uPaper", "uClouds", "uFogTex", "uRadius", "uSeaOn", "uSea", "uSeaTex"]],
      [raster, "r.", ["uChunks"]],
    ];
    for (const [p, pre, list] of names) for (const n of list) u[pre + n] = gl.getUniformLocation(p, n);
    const vao = gl.createVertexArray();
    const inst = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, FLOATS * 4, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    const empty = gl.createVertexArray();
    const tex = (filter: number, wrap: number) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      // Something to sample until the real data comes.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
      return t;
    };
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
    this.res = {
      p: { tile, sheet, raster, u },
      vao,
      empty,
      inst,
      pool: null,
      chunks: null,
      paper: tex(gl.LINEAR_MIPMAP_LINEAR, gl.REPEAT),
      clouds: tex(gl.LINEAR_MIPMAP_LINEAR, gl.REPEAT),
      fog: tex(gl.LINEAR, gl.CLAMP_TO_EDGE),
      sea: tex(gl.LINEAR, gl.CLAMP_TO_EDGE),
    };
    // What was handed over before (or before the context was lost) goes up again.
    if (this.paperTex) this.setPaper(this.paperTex);
    if (this.fogField !== undefined) this.setFog(this.fogField, this.fogAll);
    this.setSea(this.sea);
    this.forget();
    this.alloc();
  }

  /** The texture arrays, sized for the drawing buffer (grown, never shrunk); what they held goes up again as frames want it. */
  private alloc() {
    const r = this.res;
    if (!r) return;
    const gl = this.gl;
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    const array = (old: WebGLTexture | null, format: number, edge: number, layers: number, filter: number) => {
      if (old) gl.deleteTexture(old);
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, format, edge, edge, layers);
      return t;
    };
    const cap = poolCapacity(W, H, this.maxLayers, deviceMemory());
    if (!this.pool || this.pool.capacity < cap || !r.pool) {
      // Raw data: integer texels, read exactly with texelFetch, never filtered.
      r.pool = array(r.pool, gl.RGBA8UI, TILE_EDGE, cap, gl.NEAREST);
      this.pool = new TexturePool(cap);
      this.fades.clear();
    }
    const ccap = chunkCapacity(W, H, this.maxLayers, deviceMemory());
    if (this.rasters.some(Boolean) && (!this.chunks || this.chunks.capacity < ccap || !r.chunks)) {
      r.chunks = array(r.chunks, gl.RGBA8, CHUNK, ccap, gl.LINEAR);
      this.chunks = new TexturePool(ccap);
      this.chunkGen.clear();
      this.chunkFades.clear();
    }
  }

  /** The tiles to draw (one per build); null draws parchment only. */
  setTiles(doc: TilesDoc | null, feed: TileFeed | null): void {
    this.doc = doc;
    this.feed = feed;
    // The game's biome colours where tiles.json has them, ours elsewhere: the palette paintTile uses.
    const pal = paletteOf(doc?.palette).biome.slice(0, 16);
    this.pal = new Float32Array(48);
    pal.forEach((c, i) => this.pal.set([c[0] / 255, c[1] / 255, c[2] / 255], i * 3));
    this.palN = pal.length;
    this.level = undefined;
    this.lastUsed = new Set();
    this.pinned = new Set(doc ? pinnedTiles(doc.maxLevel, doc.radius).map(tileKey) : []);
    this.pool?.clear();
    this.fades.clear();
  }

  setPaper(t: Textures): void {
    this.paperTex = t;
    const r = this.res;
    if (!r) return;
    const gl = this.gl;
    const alpha = new Uint8Array(t.paper.length / 4);
    for (let i = 0; i < alpha.length; i++) alpha[i] = t.paper[4 * i + 3]!;
    const side = Math.round(Math.sqrt(alpha.length));
    gl.bindTexture(gl.TEXTURE_2D, r.paper);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, side, side, 0, gl.RED, gl.UNSIGNED_BYTE, alpha);
    gl.generateMipmap(gl.TEXTURE_2D);
    const cs = Math.round(Math.sqrt(t.clouds.length / 4));
    gl.bindTexture(gl.TEXTURE_2D, r.clouds);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cs, cs, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(t.clouds.buffer, t.clouds.byteOffset, t.clouds.byteLength));
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** The fog field; null with `all` for fog everywhere (nothing explored yet), null without for no fog at all. */
  setFog(field: FogField | null, all = false): void {
    this.fogField = field;
    this.fogAll = all;
    const r = this.res;
    if (!r || !field) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, r.fog);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, field.w, field.h, 0, gl.RED, gl.FLOAT, field.data);
  }

  setSea(mask: SeaMask | null): void {
    this.sea = mask;
    const r = this.res;
    if (!r || !mask) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, r.sea);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.n, mask.n, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data);
  }

  /** Raster 0 is drawn under the fog (woods, terrain edits), raster 1 over it (floor plans); null draws none. */
  setRaster(i: 0 | 1, src: RasterSource | null): void {
    this.rasters[i] = src;
    if (src && src.kind !== this.chunkKind[i]) {
      // Something else is shown now (a layer turned on or off): drop the old chunks at once rather than redraw them.
      this.chunkKind[i] = src.kind;
      const pre = `${i}:`;
      this.chunks?.deleteWhere((k) => k.startsWith(pre));
      for (const k of [...this.chunkGen.keys()]) if (k.startsWith(pre)) this.chunkGen.delete(k);
    }
    if (src && !this.chunks) this.alloc();
  }

  resize(w: number, h: number, dpr: number): void {
    this.cssW = Math.max(1, w);
    this.cssH = Math.max(1, h);
    this.dpr = Math.min(dpr, MAX_DPR, Math.sqrt(MAX_PIXELS / (this.cssW * this.cssH)), this.maxTex / Math.max(this.cssW, this.cssH));
    const W = Math.max(1, Math.round(this.cssW * this.dpr));
    const H = Math.max(1, Math.round(this.cssH * this.dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    this.alloc();
  }

  /**
   * Draws a frame and returns whether another is needed soon (tiles fading
   * in, arrived but not uploaded yet, chunks still to rasterize). Missing
   * tiles are asked of the feed in planView's order; an arrival only needs
   * a frame, never a redraw of anything else.
   */
  draw(fr: GLFrame): boolean {
    const r = this.res;
    if (!r || this.lost || this.disposed) return false;
    const gl = this.gl;
    const v = fr.view;
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    const k = W / this.cssW;
    const pxPerM = v.scale * k;
    const { u } = r.p;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    // Shared: the generated-zone clip.
    const seaOn = !fr.spoilers && this.sea ? 1 : 0;
    const bindSea = (pre: string) => {
      gl.uniform1f(u[pre + "uRadius"]!, this.doc?.radius ?? 10_500);
      gl.uniform1i(u[pre + "uSeaOn"]!, seaOn);
      if (this.sea) gl.uniform4f(u[pre + "uSea"]!, this.sea.origin, this.sea.step, this.sea.n, 0);
      gl.uniform1i(u[pre + "uSeaTex"]!, 4);
    };
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, r.sea);
    // The sheet program's uniforms for this view.
    gl.useProgram(r.p.sheet);
    bindSea("s.");
    gl.uniform4f(u["s.uView"]!, v.cx, v.cz, pxPerM, k);
    gl.uniform2f(u["s.uHalf"]!, W / 2, H / 2);
    const octaves = (px: number, solid: boolean, loc: string, off: string) => {
      // Two sizes of the same tile, a power of two apart, cross-faded (as the Canvas2D map's drawTiled).
      const ideal = Math.log2(px / v.scale);
      const base = Math.floor(ideal);
      const t = ideal - base;
      const s0 = 2 ** base;
      const s1 = 2 ** (base + 1);
      const fract = (x: number) => x - Math.floor(x);
      gl.uniform4f(u[loc]!, s0, s1, solid ? 1 : 1 - t, t);
      gl.uniform4f(u[off]!, fract(v.cx / s0), fract(v.cz / s0), fract(v.cx / s1), fract(v.cz / s1));
    };
    octaves(256, false, "s.uPaperOct", "s.uPaperOff");
    octaves(768, true, "s.uCloudOct", "s.uCloudOff");
    const fog = this.fogField;
    const fogMode = !fr.fog ? 0 : fog ? 2 : this.fogAll ? 1 : 0;
    gl.uniform1i(u["s.uFog"]!, fogMode);
    if (fog) gl.uniform4f(u["s.uFogBox"]!, fog.x0, fog.z0, fog.w * fog.cell, fog.h * fog.cell);
    gl.uniform1f(u["s.uRim"]!, Math.min(36, Math.max(14, 500 * v.scale)));
    gl.uniform1i(u["s.uPaper"]!, 1);
    gl.uniform1i(u["s.uClouds"]!, 2);
    gl.uniform1i(u["s.uFogTex"]!, 3);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, r.paper);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, r.clouds);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, r.fog);
    const sheet = (mode: number, paper: number) => {
      gl.bindVertexArray(r.empty);
      gl.useProgram(r.p.sheet);
      gl.uniform1i(u["s.uMode"]!, mode);
      gl.uniform1f(u["s.uPaperAlpha"]!, paper);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    // Chunks are rasterized before anything is drawn: uploads between draws would stall the pipeline.
    const chunks = this.prepareChunks(v, k, fr.now);
    sheet(0, 0.9);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    let busy = false;
    if (this.doc && this.feed && this.pool && r.pool) busy = this.drawTiles(fr, pxPerM, bindSea);
    sheet(1, 0.28);
    this.drawChunks(0, chunks[0], v);
    sheet(2, 0.35);
    this.drawChunks(1, chunks[1], v);
    gl.bindVertexArray(null);
    return busy || chunks.busy;
  }

  private upload(key: string, data: Uint8Array, keep: (k: string) => boolean): boolean {
    const r = this.res!;
    const got = this.pool!.acquire(key, keep);
    if (!got) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, r.pool);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, got.layer, TILE_EDGE, TILE_EDGE, 1, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, data);
    if (got.evicted) this.fades.drop(got.evicted);
    return true;
  }

  private drawTiles(fr: GLFrame, pxPerM: number, bindSea: (pre: string) => void): boolean {
    const r = this.res!;
    const gl = this.gl;
    const doc = this.doc!;
    const feed = this.feed!;
    const pool = this.pool!;
    const v = fr.view;
    const now = fr.now;
    const R = doc.radius;
    const hw = v.w / 2 / v.scale;
    const hh = v.h / 2 / v.scale;
    const box = { x0: v.cx - hw, z0: v.cz - hh, x1: v.cx + hw, z1: v.cz + hh };
    // Planned as on the Canvas2D map, with a tile "loaded" once it is on
    // the GPU and done fading in: until then its relatives stand in under it.
    const settled = (t: TileRef) => {
      const key = tileKey(t);
      return pool.has(key) && this.fades.alpha(key, now) >= 1;
    };
    const k = pxPerM / v.scale;
    const level = heldLevel(v.scale, k, doc.maxLevel, R, doc.tileSize, this.level);
    const plan = planView({ box, view: box, scale: v.scale, dpr: k, maxLevel: doc.maxLevel, radius: R, size: doc.tileSize, has: settled, level });
    const z = plan.z;
    // Zoomed across a level: what is already loaded at the new one fades in over the old.
    if (this.level !== undefined && z !== this.level) for (const s of plan.slots) if (pool.has(tileKey(s.tile))) this.fades.begin(tileKey(s.tile), now);
    this.level = z;
    const slotKeys = new Set(plan.slots.map((s) => tileKey(s.tile)));
    const keep = (k: string) => this.lastUsed.has(k) || slotKeys.has(k) || Number(k.slice(0, k.indexOf("/"))) <= GPU_PIN_LEVEL;
    // Up to the GPU what has arrived, in planView's order; ask for the rest.
    const wish: string[] = [];
    let low = 0;
    let pending = 0;
    this.budget.begin(performance.now());
    plan.want.forEach((t, i) => {
      const k = tileKey(t);
      if (pool.has(k)) return;
      const data = feed.get(k);
      if (!data) {
        if (feed.gone(k)) return;
        wish.push(k);
        if (i < plan.low) low = wish.length;
        return;
      }
      if (this.budget.take(performance.now()) && this.upload(k, data, keep)) this.fades.begin(k, now);
      else pending++;
    });
    feed.want(wish, low);
    const sel = slotQuads(plan.slots, (t) => {
      const key = tileKey(t);
      return pool.has(key) ? this.fades.alpha(key, now) : null;
    });
    for (const k of sel.used) pool.touch(k);
    this.lastUsed = sel.used;
    feed.keep = new Set([...sel.used, ...this.pinned]);
    const { chunks, chunksPending } = this.stats;
    this.stats = { level: z, wanted: plan.slots.length, quads: sel.quads.length, own: sel.own, ancestor: sel.ancestor, descendant: sel.descendant, blank: sel.blank, fading: sel.fading, uploads: this.budget.used, pending, pool: pool.size, capacity: pool.capacity, chunks, chunksPending };
    if (sel.quads.length) {
      this.fillInstances(sel.quads, v, R, doc.tileSize, doc.apron - 0.5, (t) => pool.layer(tileKey(t)) ?? 0);
      gl.useProgram(r.p.tile);
      const { u } = r.p;
      bindSea("t.");
      gl.uniform1i(u["t.uTiles"]!, 0);
      gl.uniform3fv(u["t.uPal"]!, this.pal);
      gl.uniform1i(u["t.uPalN"]!, this.palN);
      gl.uniform1f(u["t.uWater"]!, doc.waterLevel);
      gl.uniform1f(u["t.uPxPerM"]!, pxPerM);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, r.pool);
      gl.bindVertexArray(r.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sel.quads.length);
    }
    return pending > 0 || this.fades.busy(now);
  }

  /**
   * Plans both rasters' chunks for this view (planView over a chunk pyramid
   * of the world, a chunk pixel about a device pixel) and rasterizes what is
   * missing or out of date, nearest first, within CHUNK_MS. Chunks of other
   * zooms stand in meanwhile, and new ones fade in, as tiles do.
   */
  private prepareChunks(v: View, k: number, now: number): { 0: Quad[] | null; 1: Quad[] | null; busy: boolean } {
    const out: { 0: Quad[] | null; 1: Quad[] | null; busy: boolean } = { 0: null, 1: null, busy: false };
    const pool = this.chunks;
    const r = this.res!;
    if (!pool || !r.chunks || !this.rasters.some(Boolean)) {
      this.stats.chunks = 0;
      this.stats.chunksPending = 0;
      return out;
    }
    const gl = this.gl;
    const R = this.doc?.radius ?? 10_500;
    const hw = v.w / 2 / v.scale;
    const hh = v.h / 2 / v.scale;
    const box = { x0: v.cx - hw, z0: v.cz - hh, x1: v.cx + hw, z1: v.cz + hh };
    const used = new Set<string>();
    const todo: { i: 0 | 1; t: TileRef; fresh: boolean }[] = [];
    const plans: ({ slots: ReturnType<typeof planView>["slots"] } | null)[] = [null, null];
    for (const i of [0, 1] as const) {
      const src = this.rasters[i];
      if (!src) continue;
      const settled = (t: TileRef) => {
        const key = chunkKey(i, t);
        return pool.has(key) && this.chunkFades.alpha(key, now) >= 1;
      };
      const level = heldLevel(v.scale, k, CHUNK_LEVELS, R, CHUNK, this.chunkLevel);
      const plan = planView({ box, view: box, scale: v.scale, dpr: k, maxLevel: CHUNK_LEVELS, radius: R, size: CHUNK, has: settled, level });
      plans[i] = plan;
      // Missing chunks at this zoom first (view, then the ring round it), then ones drawn for an older gen.
      plan.want.forEach((t, n) => {
        if (t.z !== plan.z || pool.has(chunkKey(i, t))) return;
        todo.push({ i, t, fresh: n < plan.low });
      });
      for (const s of plan.slots) if (pool.has(chunkKey(i, s.tile)) && this.chunkGen.get(chunkKey(i, s.tile)) !== src.gen) todo.push({ i, t: s.tile, fresh: false });
    }
    this.chunkLevel = plans[0] || plans[1] ? heldLevel(v.scale, k, CHUNK_LEVELS, R, CHUNK, this.chunkLevel) : undefined;
    // The view's missing chunks of both rasters before anything else.
    todo.sort((a, b) => Number(b.fresh) - Number(a.fresh));
    const keep = (key: string) => this.chunkUsed.has(key) || used.has(key);
    this.chunkBudget.begin(performance.now());
    let done = 0;
    for (const { i, t } of todo) {
      if (!this.chunkBudget.take(performance.now())) break;
      const key = chunkKey(i, t);
      const fresh = !pool.has(key);
      const got = pool.acquire(key, keep);
      if (!got) continue;
      if (got.evicted) {
        this.chunkGen.delete(got.evicted);
        this.chunkFades.drop(got.evicted);
      }
      this.rasterize(this.rasters[i]!, t, R, k);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, r.chunks);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, got.layer, CHUNK, CHUNK, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.scratch as TexImageSource);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.chunkGen.set(key, this.rasters[i]!.gen);
      if (fresh) this.chunkFades.begin(key, now);
      done++;
    }
    for (const i of [0, 1] as const) {
      const plan = plans[i];
      if (!plan) continue;
      const sel = slotQuads(plan.slots, (t) => {
        const key = chunkKey(i, t);
        return pool.has(key) ? this.chunkFades.alpha(key, now) : null;
      });
      for (const key of sel.used) {
        used.add(`${i}:${key}`);
        pool.touch(`${i}:${key}`);
      }
      out[i] = sel.quads;
    }
    this.chunkUsed = used;
    this.stats.chunks = done;
    this.stats.chunksPending = todo.length - done;
    out.busy = todo.length > done || this.chunkFades.busy(now);
    return out;
  }

  /** Draws chunk `t` of a raster into the scratch canvas, world north-west at its top left. */
  private rasterize(src: RasterSource, t: TileRef, R: number, k: number) {
    this.scratch ??= typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(CHUNK, CHUNK) : Object.assign(document.createElement("canvas"), { width: CHUNK, height: CHUNK });
    const g = this.scratch.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, CHUNK, CHUNK);
    const span = (2 * R) / 2 ** t.z;
    const west = -R + t.x * span;
    const north = R - t.y * span;
    const s = CHUNK / span;
    g.setTransform(s, 0, 0, -s, -west * s, north * s);
    g.save();
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.clip();
    src.draw(g, [west, north - span, west + span, north], s / k);
    g.restore();
  }

  private drawChunks(i: 0 | 1, quads: Quad[] | null, v: View) {
    if (!quads?.length) return;
    const r = this.res!;
    const gl = this.gl;
    const pool = this.chunks!;
    this.fillInstances(quads, v, this.doc?.radius ?? 10_500, 1, 0, (t) => pool.layer(chunkKey(i, t)) ?? 0);
    gl.useProgram(r.p.raster);
    gl.uniform1i(r.p.u["r.uChunks"]!, 6);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, r.chunks);
    gl.bindVertexArray(r.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, quads.length);
  }

  /**
   * One instance per quad: its corners on screen (clip space) and in the
   * world, the part of the source it shows (in samples from `origin`, `size`
   * a tile), and layer, alpha, metres per sample.
   */
  private fillInstances(quads: readonly Quad[], v: View, R: number, size: number, origin: number, layerOf: (t: TileRef) => number) {
    const r = this.res!;
    const gl = this.gl;
    const n = quads.length;
    if (this.instData.length < n * FLOATS) this.instData = new Float32Array(n * FLOATS * 2);
    const d = this.instData;
    const sx = (x: number) => ((x - v.cx) * v.scale * 2) / v.w;
    const sy = (z: number) => ((z - v.cz) * v.scale * 2) / v.h;
    for (let i = 0; i < n; i++) {
      const q = quads[i]!;
      // Edges from the tile's integer position, so neighbours share them exactly and no seam opens.
      const span = (2 * R) / 2 ** q.dst.z;
      const w0 = -R + q.dst.x * span;
      const w1 = -R + (q.dst.x + 1) * span;
      const n0 = R - q.dst.y * span;
      const n1 = R - (q.dst.y + 1) * span;
      const [s0, t0, s1, t1] = subRect(q.src, q.dst);
      const o = i * FLOATS;
      d[o] = sx(w0);
      d[o + 1] = sy(n0);
      d[o + 2] = sx(w1);
      d[o + 3] = sy(n1);
      d[o + 4] = w0;
      d[o + 5] = n0;
      d[o + 6] = w1;
      d[o + 7] = n1;
      d[o + 8] = origin + s0 * size;
      d[o + 9] = origin + t0 * size;
      d[o + 10] = origin + s1 * size;
      d[o + 11] = origin + t1 * size;
      d[o + 12] = layerOf(q.src);
      d[o + 13] = q.alpha;
      d[o + 14] = (2 * R) / 2 ** q.src.z / size;
      d[o + 15] = 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, r.inst);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, n * FLOATS), gl.DYNAMIC_DRAW);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.lose);
    this.canvas.removeEventListener("webglcontextrestored", this.restore);
    const r = this.res;
    const gl = this.gl;
    if (r && !gl.isContextLost()) {
      for (const t of [r.pool, r.chunks, r.paper, r.clouds, r.fog, r.sea]) if (t) gl.deleteTexture(t);
      gl.deleteBuffer(r.inst);
      gl.deleteVertexArray(r.vao);
      gl.deleteVertexArray(r.empty);
      for (const p of [r.p.tile, r.p.sheet, r.p.raster]) gl.deleteProgram(p);
    }
    this.res = null;
  }
}
