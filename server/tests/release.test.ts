import { describe, expect, it } from "bun:test";
import { BRIDGE_PLUGIN_VERSION } from "../src/bridgeplugin";
import { MockAgent } from "../src/mock";

const entry = new URL("../src/server.ts", import.meta.url).pathname;

// The source modules in a bundle of server.ts, from the `// src/x.ts` header Bun
// writes above each one. The bundler runs in its own process, the same `bun build`
// the release uses minus --compile and --minify: in-process, after the other
// suites, it fails to read files.
function modules(define: string[]): string[] {
  const r = Bun.spawnSync([process.execPath, "build", "--target=bun", ...define.flatMap((d) => ["--define", d]), entry]);
  expect(r.exitCode).toBe(0);
  return [...r.stdout.toString().matchAll(/^\/\/ src\/(\S+)\.ts$/gm)].map((m) => m[1]!);
}

// Everything only the mock agent uses.
const MOCK_ONLY = ["mock", "mapmock", "mocknature", "mockpieces", "mocktiles", "mockterrain", "mockicons", "png", "bridgeplugin"];

describe("release build", () => {
  it("leaves the mock agent out when SKALD_NO_MOCK is defined", () => {
    const release = modules(['process.env.SKALD_NO_MOCK="1"']);
    expect(release).toContain("server");
    expect(release.filter((m) => MOCK_ONLY.includes(m))).toEqual([]);
  }, 30_000);

  it("keeps the mock agent in a dev build", () => {
    expect(modules([])).toEqual(expect.arrayContaining(MOCK_ONLY));
  }, 30_000);
});

describe("bridge plugin version", () => {
  it("matches the plugin source", async () => {
    const cs = await Bun.file(new URL("../../bridge/plugin/Plugin.cs", import.meta.url)).text();
    expect(/const string Version = "([^"]+)"/.exec(cs)?.[1]).toBe(BRIDGE_PLUGIN_VERSION);
  });

  it("is what the mock bridge reports", async () => {
    const m = new MockAgent(Date.now, "UTC");
    expect((await m.bridge({ op: "status" })).body).toMatchObject({ plugin: BRIDGE_PLUGIN_VERSION });
    m.stop();
  });
});
