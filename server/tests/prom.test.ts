import { describe, expect, it } from "bun:test";
import { fetchMetrics, metricQueries } from "../src/prom";

describe("prometheus", () => {
  it("builds cAdvisor queries for the game container and pod", () => {
    const q = metricQueries();
    expect(q.cpu).toBe('sum(rate(container_cpu_usage_seconds_total{namespace="valheim",container="valheim"}[2m]))');
    expect(q.memory).toContain('container_memory_working_set_bytes{namespace="valheim",container="valheim"}');
    expect(q.rx).toContain('pod=~"valheim-[a-z0-9]+-[a-z0-9]+"');
    expect(q.tx).toContain("container_network_transmit_bytes_total");
    // PromQL anchors regexes: the game pod matches, the dashboard pod does not.
    const re = /^valheim-[a-z0-9]+-[a-z0-9]+$/;
    expect(re.test("valheim-65b6679df-n2ll9")).toBe(true);
    expect(re.test("valheim-web-7c9d8f-abcde")).toBe(false);
    expect(re.test("skald-web-7c9d8f-abcde")).toBe(false);
  });

  it("honours a custom target", () => {
    const q = metricQueries({ namespace: "games", container: "server", podRegex: "vh-.*" });
    expect(q.cpu).toContain('namespace="games",container="server"');
    expect(q.rx).toContain('namespace="games",pod=~"vh-.*"');
  });

  it("parses range results and returns null when unreachable", async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ status: "success", data: { result: [{ values: [[100, "1.5"], [160, "2"]] }] } }))) as unknown as typeof fetch;
    const m = await fetchMetrics("http://p", undefined, 200_000, ok);
    expect(m!.cpu).toEqual([[100_000, 1.5], [160_000, 2]]);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await fetchMetrics("http://p", undefined, 200_000, down)).toBeNull();
  });
});
