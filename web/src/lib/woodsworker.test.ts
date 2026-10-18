import { describe, expect, it, vi } from "vitest";
import type { NatureItem } from "./nature";
import type { WoodsReply, WoodsRequest } from "./woods.worker";
import { WoodsWorker, type WoodsDraw } from "./woodsworker";

/** A stand-in worker: records what it is sent; the test answers for it. */
function fakePort() {
  const sent: WoodsRequest[] = [];
  const port = {
    onmessage: null as ((e: MessageEvent<WoodsReply>) => void) | null,
    onerror: null as ((e: Event) => void) | null,
    terminated: false,
    postMessage(m: WoodsRequest) {
      sent.push(m);
    },
    terminate() {
      this.terminated = true;
    },
  };
  const answer = (m: WoodsReply) => port.onmessage?.({ data: m } as MessageEvent<WoodsReply>);
  return { port, sent, answer };
}

const req: WoodsDraw = { t: { z: 9, x: 200, y: 300 }, R: 10_500, k: 2, at: 4, woods: true, heat: false, layers: { nature: true, pickables: false } };

describe("WoodsWorker", () => {
  it("is never ready without workers: the map draws its woods itself", async () => {
    const w = new WoodsWorker(() => null);
    expect(w.ready).toBe(false);
    expect(await w.draw(req)).toBeNull();
  });

  it("draws in the worker once it says it can", async () => {
    const f = fakePort();
    const w = new WoodsWorker(() => f.port);
    let woke = 0;
    w.onReady = () => woke++;
    expect(f.sent[0]).toEqual({ type: "probe" });
    expect(w.ready).toBe(false);
    f.answer({ type: "probe", ok: true });
    expect([w.ready, woke]).toEqual([true, 1]);
    const p = w.draw(req);
    const ask = f.sent.at(-1) as Extract<WoodsRequest, { type: "draw" }>;
    expect(ask).toMatchObject({ type: "draw", at: 4, t: req.t });
    expect(w.inflight).toBe(1);
    const px = new Uint8ClampedArray(4);
    f.answer({ type: "px", id: ask.id, px });
    expect(await p).toBe(px);
    expect(w.inflight).toBe(0);
  });

  it("falls back for good where the worker cannot draw (no OffscreenCanvas 2D)", async () => {
    const f = fakePort();
    const w = new WoodsWorker(() => f.port);
    f.answer({ type: "probe", ok: false });
    expect(w.ready).toBe(false);
    expect(f.port.terminated).toBe(true);
    expect(await w.draw(req)).toBeNull();
  });

  it("answers null to every draw waiting when the worker fails", async () => {
    const f = fakePort();
    const w = new WoodsWorker(() => f.port);
    f.answer({ type: "probe", ok: true });
    const p = w.draw(req);
    f.port.onerror?.(new Event("error"));
    expect(await p).toBeNull();
    expect(w.ready).toBe(false);
  });

  it("gives up on a worker that never answers, so the woods are drawn here", async () => {
    vi.useFakeTimers();
    const f = fakePort();
    const w = new WoodsWorker(() => f.port);
    f.answer({ type: "probe", ok: true });
    const p = w.draw(req);
    vi.advanceTimersByTime(10_000);
    expect(await p).toBeNull();
    expect(w.ready).toBe(false);
    vi.useRealTimers();
  });

  it("sends the terrain edits only when they change", () => {
    const f = fakePort();
    const w = new WoodsWorker(() => f.port);
    w.setHeat([{ x: 1, z: 2, cells: 3 }], 1);
    w.setHeat([{ x: 1, z: 2, cells: 3 }], 1);
    w.setHeat([{ x: 1, z: 2, cells: 4 }], 2);
    expect(f.sent.filter((m) => m.type === "heat")).toHaveLength(2);
  });

  it("sends only the nature chunks that arrived, changed or left", () => {
    const f = fakePort();
    const w = new WoodsWorker(() => f.port);
    const a: NatureItem[] = [{ category: "tree", species: "beech", x: 1, z: 2, yaw: 0, size: 8 }];
    const b: NatureItem[] = [{ category: "rock", species: "boulder", x: 300, z: 2, yaw: 0, size: 1 }];
    w.setNature(new Map([["0,0", a]]));
    w.setNature(new Map([["0,0", a], ["1,0", b]]));
    w.setNature(new Map([["0,0", a], ["1,0", b]]));
    w.setNature(new Map([["1,0", b]]));
    const nature = f.sent.filter((m) => m.type === "nature") as Extract<WoodsRequest, { type: "nature" }>[];
    expect(nature.map((m) => [m.add.map(([k]) => k), m.drop])).toEqual([
      [["0,0"], []],
      [["1,0"], []],
      [[], ["0,0"]],
    ]);
  });
});
