import { describe, expect, it, vi } from "vitest";
import { mockMap } from "@server/mapmock";
import { mockPieces, piecesIn } from "@server/mockpieces";
import { PieceLoader } from "./pieceload";

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
    l.onChange = changed;
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
});
