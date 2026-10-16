import { describe, expect, it } from "bun:test";
import { buildInfoMetric } from "../src/buildinfo";
import { compareVersions, isRelease, versionMismatch } from "../src/version";

describe("compareVersions", () => {
  it("compares calendar versions part by part, as numbers", () => {
    expect(compareVersions("2026.10.0", "2026.10.0")).toBe(0);
    expect(compareVersions("2026.11.0", "2026.10.0")).toBe(1);
    expect(compareVersions("2026.10.0", "2026.11.0")).toBe(-1);
    // 10 > 9 as a number, not as text
    expect(compareVersions("2026.10.0", "2026.9.3")).toBe(1);
    expect(compareVersions("2026.10.10", "2026.10.2")).toBe(1);
    expect(compareVersions("2027.1.0", "2026.12.4")).toBe(1);
    expect(compareVersions("v2026.10.1", "2026.10.0")).toBe(1);
  });

  it("puts every 0.x release before every calendar version", () => {
    expect(compareVersions("0.10.2", "2026.10.0")).toBe(-1);
    expect(compareVersions("0.99.99", "2026.1.0")).toBe(-1);
    expect(compareVersions("2026.10.0", "0.11.0")).toBe(1);
  });

  it("orders a pre-release before its release", () => {
    expect(compareVersions("2026.10.0-rc.1", "2026.10.0")).toBe(-1);
    expect(compareVersions("2026.10.0", "2026.10.0-rc.1")).toBe(1);
    expect(compareVersions("2026.11.0-rc.1", "2026.10.0")).toBe(1);
  });

  it("does not compare dev or garbage", () => {
    expect(compareVersions("dev", "2026.10.0")).toBeNull();
    expect(compareVersions("2026.10.0", "")).toBeNull();
    expect(compareVersions("latest", "2026.10.0")).toBeNull();
    expect(isRelease("dev")).toBe(false);
    expect(isRelease(undefined)).toBe(false);
    expect(isRelease("2026.10.0")).toBe(true);
  });
});

describe("versionMismatch", () => {
  it("names both sides when the agent and the panel differ", () => {
    expect(versionMismatch("2026.10.0", "2026.11.0")).toEqual({ agent: "2026.10.0", web: "2026.11.0" });
    expect(versionMismatch("2026.11.0", "2026.10.0")).toEqual({ agent: "2026.11.0", web: "2026.10.0" });
  });

  it("stays quiet when they match, for dev builds and for agents too old to say", () => {
    expect(versionMismatch("2026.10.0", "2026.10.0")).toBeNull();
    expect(versionMismatch("dev", "2026.10.0")).toBeNull();
    expect(versionMismatch("2026.10.0", "dev")).toBeNull();
    expect(versionMismatch("dev", "dev")).toBeNull();
    expect(versionMismatch(undefined, "2026.10.0")).toBeNull();
    expect(versionMismatch("", "2026.10.0")).toBeNull();
  });
});

describe("buildInfoMetric", () => {
  it("renders one gauge sample with escaped labels", () => {
    expect(buildInfoMetric("web", "2026.10.0")).toBe(
      '# HELP skald_build_info The Skald release this component was built from; value is always 1.\n# TYPE skald_build_info gauge\nskald_build_info{component="web",version="2026.10.0"} 1\n',
    );
    expect(buildInfoMetric("web", 'a"b\\c')).toContain('version="a\\"b\\\\c"');
  });
});
