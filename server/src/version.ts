// Release version helpers, shared with the web app (no runtime imports here).

/** Numbers and pre-release suffix of `2026.10.0`, `v2026.10.0-rc.1` or `0.10.2`; null for anything else (`dev`). */
function parse(v: string): { parts: number[]; pre: string } | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return { parts: m[1]!.split(".").map(Number), pre: m[2] ?? "" };
}

/**
 * Orders two release versions: negative when a is older, positive when newer,
 * 0 when equal; null when either is not a version (`dev`, empty). Parts are
 * compared as numbers, one by one, so `2026.10.0` < `2026.11.0` and every old
 * `0.x` sorts before every calendar version. A pre-release (`-rc.1`) is older
 * than the release with the same numbers.
 */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  const n = Math.max(x.parts.length, y.parts.length);
  for (let i = 0; i < n; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** A release build: not `dev`, not empty, not missing. */
export const isRelease = (v: string | null | undefined): v is string => !!v && parse(v) !== null;

/**
 * Agent and panel versions when both are releases and differ, else null. A
 * `dev` build on either side, or an agent too old to report a version, never
 * warns.
 */
export function versionMismatch(agent: string | null | undefined, web: string | null | undefined): { agent: string; web: string } | null {
  if (!isRelease(agent) || !isRelease(web)) return null;
  return compareVersions(agent, web) === 0 ? null : { agent, web };
}
