import { describe, expect, it } from "bun:test";
import { RELEASES_URL, UpdateChecker } from "../src/update";

type Call = { url: string; headers: Record<string, string> };

/** A fetch that answers from a list and records what was asked. */
function fakeFetch(answers: (() => Response)[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const release = (tag: string, etag = '"e1"') => () =>
  new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/krystianslowik/skald/releases/tag/${tag}`, name: tag }), { status: 200, headers: { ETag: etag } });

function checker(current: string, answers: (() => Response)[], clock = () => 0) {
  const f = fakeFetch(answers);
  const logs: string[] = [];
  const c = new UpdateChecker({ current, fetchImpl: f.impl, clock, log: (m) => logs.push(m) });
  return { c, calls: f.calls, logs };
}

describe("UpdateChecker", () => {
  it("reports a newer release with its notes, asking with a plain GET", async () => {
    const { c, calls } = checker("2026.10.0", [release("v2026.11.0")]);
    await c.check();
    expect(c.get()).toEqual({ version: "2026.11.0", url: "https://github.com/krystianslowik/skald/releases/tag/v2026.11.0" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RELEASES_URL);
    expect(calls[0]!.headers).toEqual({ "User-Agent": "skald/2026.10.0", Accept: "application/vnd.github+json" });
  });

  it("reports nothing for the same or an older release", async () => {
    const same = checker("2026.10.0", [release("v2026.10.0")]);
    await same.c.check();
    expect(same.c.get()).toBeNull();
    const older = checker("2026.11.0", [release("v2026.10.0")]);
    await older.c.check();
    expect(older.c.get()).toBeNull();
    const legacy = checker("2026.10.0", [release("v0.11.0")]);
    await legacy.c.check();
    expect(legacy.c.get()).toBeNull();
  });

  it("fails silently, logs once and keeps what it knew", async () => {
    let now = 0;
    const { c, logs } = checker(
      "2026.10.0",
      [
        release("v2026.11.0"),
        () => {
          throw new TypeError("network blocked");
        },
        () => new Response("rate limited", { status: 403 }),
      ],
      () => now,
    );
    await c.check();
    now += 13 * 60 * 60 * 1000;
    await c.check();
    await c.check();
    expect(c.get()).toEqual({ version: "2026.11.0", url: "https://github.com/krystianslowik/skald/releases/tag/v2026.11.0" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("network blocked");
  });

  it("sends the ETag back and keeps the answer on 304", async () => {
    const { c, calls } = checker("2026.10.0", [release("v2026.11.0", '"abc"'), () => new Response(null, { status: 304 })]);
    await c.check();
    await c.check();
    expect(calls[1]!.headers["If-None-Match"]).toBe('"abc"');
    expect(c.get()?.version).toBe("2026.11.0");
  });

  it("asks at most once per 12 hours, lazily, and never from a dev build", async () => {
    let now = 0;
    const { c, calls } = checker("2026.10.0", [release("v2026.10.0"), release("v2026.11.0")], () => now);
    expect(calls).toHaveLength(0);
    c.get();
    c.get();
    await c.check(); // joins the check get() started
    expect(calls).toHaveLength(1);
    now += 11 * 60 * 60 * 1000;
    expect(c.get()).toBeNull();
    expect(calls).toHaveLength(1);
    now += 60 * 60 * 1000;
    c.get();
    await c.check();
    expect(calls).toHaveLength(2);
    expect(c.get()?.version).toBe("2026.11.0");

    const dev = checker("dev", [release("v2026.11.0")]);
    expect(dev.c.get()).toBeNull();
    expect(dev.calls).toHaveLength(0);
  });
});
