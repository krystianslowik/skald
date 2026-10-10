// World helpers: map link and boss progress. Raid and boss names live in src/i18n.

/**
 * World-generation version for valheim-map.world. Worlds created on/after the
 * Deep North update (1.0.7, 2026-09-10) all use the 1.0.7 generator, which is
 * also the site's LatestSupportedVersion. Always pass it explicitly: with
 * `offset` + `zoom` but no `ver` the site falls back to 0.147.3 (wrong map).
 */
export const MAP_GEN_VERSION = "1.0.7";

/** Same shape as the site's own CreateMapUrl (seedv6.js). */
export function mapUrl(seedName: string): string {
  return `https://valheim-map.world/?seed=${encodeURIComponent(seedName)}&offset=0,0&zoom=0.600&ver=${MAP_GEN_VERSION}`;
}

/**
 * A valheim-map.world link centred on a world point. Checked against the
 * site (its page hands the raw parameters to its map and writes them back as
 * you pan): `offset` is the world x,z (metres, z north) under the centre of
 * the view, and `zoom` is the view scale, smaller is closer: 0.6 shows the
 * whole world, 0.1 is about 2.7 m per screen pixel on a 900 px tall window.
 */
export const MAP_CLOSE_ZOOM = 0.1;

export function mapUrlAt(seedName: string, x: number, z: number, zoom = MAP_CLOSE_ZOOM): string {
  return `https://valheim-map.world/?seed=${encodeURIComponent(seedName)}&offset=${Math.round(x)},${Math.round(z)}&zoom=${zoom.toFixed(3)}&ver=${MAP_GEN_VERSION}`;
}

/** The site's own page for a seed, for the embedded terrain view. */
export function terrainUrl(seedName: string): string {
  return `https://valheim-map.world/?seed=${encodeURIComponent(seedName)}&ver=${MAP_GEN_VERSION}`;
}

export interface BossProgress {
  /** Valheim global key, e.g. `defeated_eikthyr`. */
  key: string;
  /** null until the agent can read global keys from the save. */
  defeated: boolean | null;
}

export const BOSSES: readonly BossProgress[] = [
  { key: "defeated_eikthyr", defeated: null },
  { key: "defeated_gdking", defeated: null },
  { key: "defeated_bonemass", defeated: null },
  { key: "defeated_dragon", defeated: null },
  { key: "defeated_goblinking", defeated: null },
  { key: "defeated_queen", defeated: null },
  { key: "defeated_fader", defeated: null },
];
