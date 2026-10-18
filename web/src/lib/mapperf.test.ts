import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapPerf, setMapPerf, useMapPerf } from "./mapperf";

describe("map performance mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    setMapPerf(false);
    localStorage.clear();
  });

  it("is off until turned on, and remembered per browser", () => {
    localStorage.clear();
    expect(mapPerf()).toBe(false);
    const { result } = renderHook(() => useMapPerf());
    expect(result.current.on).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.on).toBe(true);
    expect(localStorage.getItem("skald_map_perf")).toBe("1");
    act(() => result.current.toggle());
    expect(localStorage.getItem("skald_map_perf")).toBe("0");
  });

  it("follows another tab", () => {
    const { result } = renderHook(() => useMapPerf());
    act(() => {
      localStorage.setItem("skald_map_perf", "1");
      window.dispatchEvent(new StorageEvent("storage", { key: "skald_map_perf" }));
    });
    expect(result.current.on).toBe(true);
  });

  it("keeps the choice for the visit when storage refuses it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    setMapPerf(true);
    expect(mapPerf()).toBe(true);
  });
});
