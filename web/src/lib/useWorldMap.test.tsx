import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorldMap } from "./useWorldMap";

let hidden = false;
let mapCalls = 0;

beforeEach(() => {
  hidden = false;
  mapCalls = 0;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      mapCalls += 1;
      return new Response(null, { status: 503 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as unknown as { hidden?: boolean }).hidden;
});

const settle = () => act(async () => void (await Promise.resolve()));

describe("useWorldMap in a hidden tab", () => {
  it("waits with the refetch after a save until the page is shown again", async () => {
    const { rerender } = renderHook(({ k }) => useWorldMap(k), { initialProps: { k: "save-1" } });
    await settle();
    expect(mapCalls).toBe(1);

    hidden = true;
    rerender({ k: "save-2" });
    rerender({ k: "save-3" });
    await settle();
    expect(mapCalls).toBe(1);

    hidden = false;
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(mapCalls).toBe(2);

    // Shown: a new save is fetched at once.
    rerender({ k: "save-4" });
    await settle();
    expect(mapCalls).toBe(3);
  });
});
