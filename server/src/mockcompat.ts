import type { CompatCheck, CompatResult, CompatTrigger, CompatView } from "./types";

/** What MOCK_COMPAT may ask for; "none" is an agent that has not checked yet. */
export const MOCK_COMPAT_MODES = ["ok", "warn", "fail", "pending", "none"] as const;
export type MockCompatMode = (typeof MOCK_COMPAT_MODES)[number];

const PREVIOUS = "l-1.0.16";

/**
 * The mock's compatibility check after the game updated from l-1.0.16 to the
 * build it runs. `fail` is the l-1.0.20 inventory change: chests saved in a
 * format the agent does not read, with the bridge not tested on the build.
 */
export function mockCompat(mode: string, build: string, net: number, now: number, trigger: CompatTrigger = "update"): CompatView {
  if (mode === "none") return { running: false, result: null };
  const save: CompatCheck = { name: "save", status: "ok", detail: { generation: 4, chunks: 412, chunksUnreadable: 0, containersUnreadable: 0, locationsRead: true, metaRead: true } };
  const terrain: CompatCheck = { name: "terrain", status: "ok", detail: { build } };
  const bridge: CompatCheck = { name: "bridge", status: "ok", detail: { plugin: "0.2.0", gameBuild: build, tested: true, acknowledged: false } };
  const logs: CompatCheck = { name: "logs", status: "ok", detail: { crossplay: true, worldLoaded: true, worldLoadedSeconds: 25, joinCode: true } };
  let awaitingSave = false;
  if (mode === "fail") {
    save.status = "fail";
    save.reason = "containers_unreadable";
    save.detail = { ...save.detail, containersUnreadable: 41, containerReason: "unreadable inventory: version 111" };
    bridge.status = "warn";
    bridge.reason = "untested";
    bridge.detail = { ...bridge.detail, tested: false };
    terrain.status = "pending";
    terrain.reason = "gameBuild";
  } else if (mode === "warn") {
    logs.status = "warn";
    logs.reason = "join_code_missing";
    logs.detail = { ...logs.detail, joinCode: false };
  } else if (mode === "pending") {
    save.status = "pending";
    save.reason = "save_before_update";
    awaitingSave = true;
  }
  const checks: CompatCheck[] = [
    { name: "version", status: "ok", reason: "updated", detail: { build, networkVersion: net, previousBuild: PREVIOUS, previousNetworkVersion: net - 1, networkChanged: true } },
    save,
    terrain,
    bridge,
    logs,
  ];
  const status = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
  const result: CompatResult = {
    build,
    networkVersion: net,
    previousBuild: PREVIOUS,
    previousNetworkVersion: net - 1,
    updated: true,
    trigger,
    startedAt: new Date(now - 95_000).toISOString(),
    checkedAt: new Date(now - 60_000).toISOString(),
    status,
    awaitingSave,
    generation: 4,
    checks,
  };
  return { running: false, result };
}
