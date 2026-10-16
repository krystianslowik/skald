// The service worker's cache name is stamped per build, so each deploy ships a
// byte-different sw.js: the browser installs it, and its `activate` drops the
// previous build's cache with every old chunk in it.

/** The token in `public/sw.js` that the build replaces. */
export const SW_BUILD_TOKEN = "__SKALD_BUILD__";

/** A short, stable id for a build: FNV-1a over its sorted output file names (which carry content hashes). */
export function buildId(files: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of [...files].sort().join("\n")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function stampServiceWorker(source: string, files: readonly string[]): string {
  if (!source.includes(SW_BUILD_TOKEN)) throw new Error(`sw.js has no ${SW_BUILD_TOKEN} to stamp`);
  // The worker's own code counts too: a change to it alone is a new build.
  return source.replaceAll(SW_BUILD_TOKEN, buildId([...files, source]));
}
