/**
 * The Skald release this skald-web was built from. The image build sets it with
 * `bun build --define process.env.SKALD_VERSION='"2026.10.0"'`, so it is part of
 * the binary; `bun run dev` and tests report "dev".
 */
export const VERSION: string = process.env.SKALD_VERSION || "dev";

/** `skald_build_info` in the Prometheus text format. */
export function buildInfoMetric(component: string, version: string): string {
  const v = version.replace(/[\\"\n]/g, (c) => (c === "\n" ? "\\n" : `\\${c}`));
  return [
    "# HELP skald_build_info The Skald release this component was built from; value is always 1.",
    "# TYPE skald_build_info gauge",
    `skald_build_info{component="${component}",version="${v}"} 1`,
    "",
  ].join("\n");
}
