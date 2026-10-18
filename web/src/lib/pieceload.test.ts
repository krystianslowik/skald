import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMap } from "@server/mapmock";
import { mockPieces, piecesIn } from "@server/mockpieces";
import { natureLoader } from "./nature";
import { Lanes, PieceLoader, RETRY_FIRST } from "./pieceload";

const all = mockPieces(mockMap().storage!);
const settle = () => new Promise((r) => setTimeout(r, 0));
const boxOf = (url: string) => ["x0", "z0", "x1", "z1"].map((k) => Number(new URL(url, "http://x").searchParams.get(k))) as [number, number, number, number];

function agent(max = 20_000) {
  return vi.fn(async (url: string | URL | Request) => Response.json(piecesIn(all, boxOf(String(url)), 1, max)));
}

describe("PieceLoader", () => {
  it("fetches the chunks a view touches once, and a pan over them costs nothing", async () => {
    const fetchImpl = agent();
    const l = new PieceLoader(fetchImpl as typeof fetch);
    const changed = vi.fn();
    l.subscribe(changed);
    l.want([200, -360, 240, -330], "1");
    await settle();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("/api/pieces?x0=0&z0=-512&x1=512&z1=0");
    expect(l.pieces.length).toBeGreaterThan(300);
    expect(changed).toHaveBeenCalled();
    l.want([210, -350, 250, -320], "1");
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // A new save asks again (the browser revalidates by ETag); the old plan stays until then.
    const before = l.pieces;
    l.want([210, -350, 250, -320], "2");
    expect(l.pieces).toBe(before);
    await settle();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("splits a truncated answer into quarters and loses nothing", async () => {
    const full = new PieceLoader(agent() as typeof fetch);
    full.want([200, -360, 240, -330], "1");
    const cut = agent(850);
    const split = new PieceLoader(cut as typeof fetch);
    split.want([200, -360, 240, -330], "1");
    for (let i = 0; i < 20; i++) await settle();
    expect(cut.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(split.pieces.length).toBe(full.pieces.length);
  });

  it("stops asking an agent without floor plans, and an older server's page counts as none", async () => {
    const old = vi.fn(async () => new Response("404 page not found", { status: 404 }));
    const l = new PieceLoader(old as typeof fetch);
    l.want([0, 0, 10, 10], "1");
    await settle();
    await settle();
    l.want([0, 0, 1000, 10], "1");
    l.want([3000, 3000, 3100, 3100], "1");
    await settle();
    expect(old).toHaveBeenCalledTimes(1);
    expect(l.pieces).toEqual([]);
    // The SPA's index.html, or the map itself, from a server that has no /api/pieces route.
    const spa = vi.fn(async () => Response.json({ meta: {}, land: {} }));
    const s = new PieceLoader(spa as typeof fetch);
    s.want([0, 0, 10, 10], "1");
    await settle();
    await settle();
    s.want([600, 0, 610, 10], "1");
    await settle();
    expect(spa).toHaveBeenCalledTimes(1);
    expect(s.pieces).toEqual([]);
  });

  it("backs off while the map is not built yet", async () => {
    let now = 0;
    const early = vi.fn(async () => new Response("{}", { status: 503 }));
    const l = new PieceLoader(early as typeof fetch, () => now);
    l.want([0, 0, 10, 10], "1");
    await settle();
    await settle();
    l.want([0, 0, 10, 10], "1");
    expect(early).toHaveBeenCalledTimes(1);
    now = 60_000;
    l.want([0, 0, 10, 10], "1");
    await settle();
    expect(early).toHaveBeenCalledTimes(2);
  });

  it("backs off a failed chunk alone: the rest of the view loads, and it is asked again without the map moving", async () => {
    vi.useFakeTimers();
    const ok = agent();
    let resets = 2;
    const flaky = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("x0=0&z0=-512") && resets-- > 0) throw new TypeError("network connection was lost");
      return ok(url);
    });
    const l = new PieceLoader(flaky as typeof fetch, Date.now);
    // Four chunks: 0,-1 fails twice.
    l.want([-100, -600, 100, -400], "1");
    await vi.advanceTimersByTimeAsync(0);
    expect(l.loaded.size).toBe(3);
    expect(l.stats()).toMatchObject({ failed: 1, off: false });
    // A settle meanwhile does not ask again before the backoff is out.
    l.want([-100, -600, 100, -400], "1");
    await vi.advanceTimersByTimeAsync(RETRY_FIRST - 10);
    expect(flaky).toHaveBeenCalledTimes(4);
    // Out by itself, with nothing moving: fails again, and waits twice as long.
    await vi.advanceTimersByTimeAsync(10);
    expect(flaky).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(2 * RETRY_FIRST - 10);
    expect(flaky).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(10);
    expect(flaky).toHaveBeenCalledTimes(6);
    expect(l.loaded.size).toBe(4);
    expect(l.stats().failed).toBe(0);
  });

  it("asks a cut-off answer again rather than taking the layer for missing", async () => {
    vi.useFakeTimers();
    const ok = agent();
    let cut = true;
    const f = vi.fn(async (url: string | URL | Request) => {
      if (cut) {
        cut = false;
        return new Response('{"prefabs":[["Wall","wall",2,0.2', { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return ok(url);
    });
    const l = new PieceLoader(f as typeof fetch, Date.now);
    l.want([200, -360, 240, -330], "1");
    await vi.advanceTimersByTimeAsync(0);
    expect(l.stats()).toMatchObject({ off: false, failed: 1, loaded: 0 });
    // Other chunks are still asked for meanwhile.
    l.want([600, -360, 640, -330], "1");
    await vi.advanceTimersByTimeAsync(0);
    expect(l.loaded.size).toBe(1);
    l.want([200, -360, 240, -330], "1");
    await vi.advanceTimersByTimeAsync(RETRY_FIRST);
    expect(l.loaded.has("0,-1")).toBe(true);
    expect(l.pieces.length).toBeGreaterThan(300);
  });

  it("takes a 404 for a missing endpoint only before anything answered", async () => {
    vi.useFakeTimers();
    const ok = agent();
    let gone = false;
    const f = vi.fn(async (url: string | URL | Request) => (gone ? new Response("{}", { status: 404 }) : ok(url)));
    const l = new PieceLoader(f as typeof fetch, Date.now);
    l.want([200, -360, 240, -330], "1");
    await vi.advanceTimersByTimeAsync(0);
    expect(l.loaded.size).toBe(1);
    // The world map switched off for a moment: a hiccup, asked again later.
    gone = true;
    l.want([600, -360, 640, -330], "1");
    await vi.advanceTimersByTimeAsync(0);
    expect(l.stats()).toMatchObject({ off: false, failed: 1 });
    gone = false;
    await vi.advanceTimersByTimeAsync(RETRY_FIRST);
    expect(l.loaded.size).toBe(2);
  });

  it("waits as a whole when the agent keeps failing, or says how long to wait", async () => {
    vi.useFakeTimers();
    const down = vi.fn(async () => new Response("{}", { status: 502 }));
    const l = new PieceLoader(down as typeof fetch, Date.now, new Lanes(1));
    // Nine chunks with the ring, one request at a time: three failures in a row and the rest wait.
    l.want([200, -360, 240, -330], "1", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(down).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(RETRY_FIRST - 10);
    expect(down).toHaveBeenCalledTimes(3);
    const busy = vi.fn(async () => new Response("{}", { status: 503, headers: { "Retry-After": "5" } }));
    const b = new PieceLoader(busy as typeof fetch, Date.now, new Lanes(1));
    b.want([200, -360, 240, -330], "1", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(busy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4900);
    expect(busy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(busy.mock.calls.length).toBeGreaterThan(1);
  });

  it("takes a page for a missing endpoint, and a refused box for an empty one", async () => {
    const page = vi.fn(async () => new Response("<!doctype html><title>Skald</title>", { status: 200, headers: { "Content-Type": "text/html" } }));
    const p = new PieceLoader(page as typeof fetch);
    p.want([0, 0, 10, 10], "1");
    await settle();
    await settle();
    expect(p.stats().off).toBe(true);
    const refused = vi.fn(async () => Response.json({ error: "box too large" }, { status: 400 }));
    const r = new PieceLoader(refused as typeof fetch);
    r.want([0, 0, 10, 10], "1");
    await settle();
    await settle();
    r.want([0, 0, 10, 10], "1");
    await settle();
    expect(refused).toHaveBeenCalledTimes(1);
    expect(r.stats()).toMatchObject({ off: false, failed: 0, loaded: 1 });
  });

  it("cancels what the view left behind, and a cancelled chunk is no failure", async () => {
    const signals: AbortSignal[] = [];
    const hang = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    const l = new PieceLoader(hang as typeof fetch);
    l.want([10, 10, 20, 20], "1");
    await settle();
    expect(signals).toHaveLength(1);
    l.want([5000, 5000, 5010, 5010], "1");
    expect(signals[0]!.aborted).toBe(true);
    await settle();
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);
    expect(l.stats()).toMatchObject({ failed: 0, inflight: 1 });
  });

  it("shares its request slots: the view before the ring, floor plans before nature", async () => {
    const order: string[] = [];
    const record = vi.fn(async (url: string | URL | Request) => {
      order.push(String(url));
      return Response.json(String(url).startsWith("/api/pieces") ? { prefabs: [], pieces: [] } : { kinds: [], items: [] });
    });
    const lanes = new Lanes(1);
    const plans = new PieceLoader(record as typeof fetch, undefined, lanes);
    const woods = natureLoader(record as typeof fetch, undefined, lanes);
    // Asked one after the other: the views first, plans before nature, then both rings.
    woods.want([200, -360, 240, -330], "1", 1);
    plans.want([200, -360, 240, -330], "1", 1);
    for (let i = 0; i < 80; i++) await settle();
    expect(order).toHaveLength(9 + 9);
    expect(order[0]).toBe("/api/pieces?x0=0&z0=-512&x1=512&z1=0");
    expect(order[1]).toBe("/api/nature?x0=0&z0=-512&x1=256&z1=-256");
    expect(order.slice(2, 10).every((u) => u.startsWith("/api/pieces"))).toBe(true);
    expect(order.slice(10).every((u) => u.startsWith("/api/nature"))).toBe(true);
    expect(plans.loaded.size + woods.loaded.size).toBe(18);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

