import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChunkBoundary } from "../components/ErrorBoundary";
import { I18nProvider } from "../i18n";
import { en } from "../i18n/en";
import { pl } from "../i18n/pl";
import { chunkUrl, failedChunkUrl, isChunkError, lazyChunk, page, probeChunk, recoverChunk, reloadOnce } from "./chunks";

/** Per-tab storage for the loop guard; Node's own experimental global shadows jsdom's. */
function memorySession() {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
}

const chromeMiss = () => new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1/assets/MapView-Old123.js");
const safariMiss = () => new TypeError("Importing a module script failed.");

let reload: ReturnType<typeof vi.fn<() => void>>;
const realReload = page.reload;
beforeEach(() => {
  memorySession();
  reload = vi.fn<() => void>();
  page.reload = reload;
  page.reloading = false;
  page.warmed.clear();
});
afterEach(() => {
  page.reload = realReload;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The tab after its one reload: the guard stamp is fresh, the page itself is new. */
function afterReload() {
  reloadOnce();
  page.reloading = false;
  reload.mockClear();
}

describe("isChunkError", () => {
  it("knows the browsers' and Vite's chunk-load errors, and nothing else", () => {
    expect(isChunkError(chromeMiss())).toBe(true);
    expect(isChunkError(safariMiss())).toBe(true);
    expect(isChunkError(new TypeError("error loading dynamically imported module: /assets/x.js"))).toBe(true);
    expect(isChunkError(new TypeError("'text/html' is not a valid JavaScript MIME type."))).toBe(true);
    expect(isChunkError(new Error("Unable to preload CSS for /assets/x.css"))).toBe(true);
    expect(isChunkError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });
});

describe("reloadOnce", () => {
  it("reloads once, then holds off for a minute so a broken build cannot loop", () => {
    expect(reloadOnce(1_000_000)).toBe(true);
    page.reloading = false;
    expect(reloadOnce(1_030_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    // A later deploy in the same tab gets its own reload.
    expect(reloadOnce(1_000_000 + 61_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("asks for one reload even when several chunks fail at once", () => {
    expect(reloadOnce()).toBe(true);
    expect(reloadOnce()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores a reload stamped ahead of the clock (the clock was set back)", () => {
    sessionStorage.setItem("skald.chunkReload", String(Date.now() + 10 * 60_000));
    expect(reloadOnce()).toBe(true);
  });

  it("does not reload offline or without sessionStorage, where it could not help or could loop", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(reloadOnce()).toBe(false);
    vi.restoreAllMocks();
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(reloadOnce()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("a lazy chunk gone after a deploy", () => {
  const failing = (err: Error) => lazyChunk<object>(() => Promise.reject(err), "MapView");
  const Sheet = (locale: "en" | "pl", Lazy: ReturnType<typeof failing>, onClose?: () => void) =>
    render(
      <I18nProvider locale={locale}>
        <p>Hearth</p>
        <ChunkBoundary overlay onClose={onClose}>
          <Suspense fallback={null}>
            <Lazy />
          </Suspense>
        </ChunkBoundary>
      </I18nProvider>,
    );

  it("reloads the page once and keeps the rest of the page up meanwhile", async () => {
    Sheet("en", failing(chromeMiss()));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Hearth")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a reload card instead of a blank page when the reload already happened (EN and PL)", async () => {
    afterReload();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const close = vi.fn();
    const view = Sheet("en", failing(safariMiss()), close);
    expect(await screen.findByRole("alert")).toHaveTextContent(en["crash.stale"]);
    expect(screen.getByText("Hearth")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en["crash.reload"] }));
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: en["crash.close"] }));
    expect(close).toHaveBeenCalledTimes(1);
    view.unmount();

    Sheet("pl", failing(safariMiss()));
    expect(await screen.findByRole("alert")).toHaveTextContent(pl["crash.stale"]);
    expect(screen.getByRole("button", { name: pl["crash.reload"] })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: pl["crash.close"] })).toBeNull();
  });

  it("does not reload for an ordinary error, and does not blame an update", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    Sheet("en", failing(new Error("boom")));
    expect(await screen.findByRole("alert")).toHaveTextContent(en["crash.body"]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("clears the card when its reset key changes, so the app can still go to the login", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Boom = () => {
      throw new Error("boom");
    };
    const app = (auth: string) => (
      <I18nProvider locale="en">
        <ChunkBoundary resetKey={auth}>{auth === "in" ? <Boom /> : <p>Login</p>}</ChunkBoundary>
      </I18nProvider>
    );
    const view = render(app("in"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    view.rerender(app("out"));
    expect(await screen.findByText("Login")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a lazy chunk that fails offline or with the server down", () => {
  const url = "/assets/MapView-Abc123.js";
  const failing = () => lazyChunk<object>(() => Promise.reject(safariMiss()), "MapView");
  const Sheet = (locale: "en" | "pl", Lazy: ReturnType<typeof failing>, onClose?: () => void) =>
    render(
      <I18nProvider locale={locale}>
        <p>Hearth</p>
        <ChunkBoundary overlay onClose={onClose}>
          <Suspense fallback={null}>
            <Lazy />
          </Suspense>
        </ChunkBoundary>
      </I18nProvider>,
    );
  let onLine = true;
  let fetchChunk: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onLine = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => onLine);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("__skaldChunks", { MapView: url });
    fetchChunk = vi.fn(async () => new Response("export default 1", { status: 200 }));
    vi.stubGlobal("fetch", fetchChunk);
  });

  it("knows the built chunk URLs, and has none outside a build", () => {
    expect(chunkUrl("MapView")).toBe(url);
    expect(chunkUrl("Nope")).toBeUndefined();
    vi.stubGlobal("__skaldChunks", undefined);
    expect(chunkUrl("MapView")).toBeUndefined();
  });

  it("offline: says there is no connection, not that Skald was updated, and does not reload (EN and PL)", async () => {
    onLine = false;
    const view = Sheet("en", failing(), () => undefined);
    const card = await screen.findByRole("alert");
    expect(card).toHaveTextContent(en["crash.offline"]);
    expect(card).not.toHaveTextContent(en["crash.stale"]);
    expect(reload).not.toHaveBeenCalled();
    expect(fetchChunk).not.toHaveBeenCalled();
    view.unmount();

    Sheet("pl", failing());
    expect(await screen.findByRole("alert")).toHaveTextContent(pl["crash.offline"]);
  });

  it("back online: fetches the chunk again and reloads the page once", async () => {
    onLine = false;
    Sheet("en", failing());
    await screen.findByRole("alert");
    onLine = true;
    act(() => void window.dispatchEvent(new Event("online")));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(fetchChunk.mock.calls[0]?.[0]).toBe(url);
  });

  it("back online: also fetches every chunk the failed one imports, with ordinary requests, before the reload", async () => {
    // WebKit keeps a failed dependency (a chunk shared with the admin sheets) across the reload until it is fetched for real.
    const deps = ["/assets/chestadd-D4.js", "/assets/Sheet-E5.js"];
    vi.stubGlobal("__skaldChunkDeps", { [url]: deps, "/assets/Other-F6.js": ["/assets/never-G7.js"] });
    const fetched: string[] = [];
    fetchChunk.mockImplementation(async (u: string, init?: RequestInit) => {
      if (init?.cache !== "no-store") fetched.push(u);
      return new Response("export default 1", { status: 200 });
    });
    let beforeReload: string[] = [];
    reload.mockImplementation(() => void (beforeReload = [...fetched].sort()));
    onLine = false;
    Sheet("en", failing());
    await screen.findByRole("alert");
    onLine = true;
    act(() => void window.dispatchEvent(new Event("online")));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(beforeReload).toEqual([url, ...deps].sort());
  });

  it("warms the entry module and its static imports before reloading", async () => {
    const entry = document.createElement("script");
    entry.type = "module";
    entry.src = "/assets/index-A1.js";
    const preload = document.createElement("link");
    preload.rel = "modulepreload";
    preload.href = "/assets/Sheet-B2.js";
    document.head.append(entry, preload);

    try {
      const fetched: string[] = [];
      let beforeReload: string[] = [];
      fetchChunk.mockImplementation(async (u: string, init?: RequestInit) => {
        if (init?.cache !== "no-store") fetched.push(u);
        return new Response("export default 1", { status: 200 });
      });
      reload.mockImplementation(() => void (beforeReload = [...fetched].sort()));

      expect(await recoverChunk([url])).toBe("reloading");
      expect(beforeReload).toEqual([url, "/assets/index-A1.js", "/assets/Sheet-B2.js"].sort());
    } finally {
      entry.remove();
      preload.remove();
    }
  });

  it("withholds the reload when the entry module could not be warmed", async () => {
    const entry = document.createElement("script");
    entry.type = "module";
    entry.src = "/assets/index-C3.js";
    document.head.append(entry);

    try {
      fetchChunk.mockImplementation(async (u: string, init?: RequestInit) => {
        if (init?.cache !== "no-store" && u === "/assets/index-C3.js") return new Response("Unavailable", { status: 503 });
        return new Response("export default 1", { status: 200 });
      });

      expect(await recoverChunk([url])).toBe("down");
      expect(reload).not.toHaveBeenCalled();
      expect(page.warmed.has("/assets/index-C3.js")).toBe(false);
    } finally {
      entry.remove();
    }
  });

  it("knows what each built chunk imports, and nothing outside a build", async () => {
    const { chunkDeps } = await import("./chunks");
    vi.stubGlobal("__skaldChunkDeps", { [url]: ["/assets/chestadd-D4.js"] });
    expect(chunkDeps(url)).toEqual(["/assets/chestadd-D4.js"]);
    expect(chunkDeps("/assets/Other-F6.js")).toEqual([]);
    vi.stubGlobal("__skaldChunkDeps", undefined);
    expect(chunkDeps(url)).toEqual([]);
  });

  it("closed offline and opened again online: reloads at once", async () => {
    onLine = false;
    const Lazy = failing();
    const close = vi.fn();
    const view = Sheet("en", Lazy, close);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: en["crash.close"] }));
    view.unmount();
    onLine = true;
    // React.lazy keeps the rejection, so the boundary sees the same offline error again.
    Sheet("en", Lazy, close);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("server down while the device is online: the offline note, no reload into an error page", async () => {
    fetchChunk.mockRejectedValue(new TypeError("Load failed"));
    Sheet("en", failing());
    expect(await screen.findByRole("alert")).toHaveTextContent(en["crash.offline"]);
    expect(fetchChunk.mock.calls[0]?.[0]).toBe(url);
    expect(reload).not.toHaveBeenCalled();
  });

  it("server down while the device is online: keeps checking, and reloads once the server answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fetchChunk.mockRejectedValue(new TypeError("Load failed"));
      Sheet("en", failing());
      await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(en["crash.offline"]));
      // The load's own probe found it down: no second request at once.
      expect(fetchChunk).toHaveBeenCalledTimes(1);
      await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
      expect(fetchChunk).toHaveBeenCalledTimes(2);
      expect(reload).not.toHaveBeenCalled();
      fetchChunk.mockResolvedValue(new Response("export default 1", { status: 200 }));
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes past the browser cache and the service worker, and counts any answer as the server being up", async () => {
    fetchChunk.mockResolvedValue(new Response("", { status: 500 }));
    expect(await probeChunk(url)).toBe("gone");
    const [, init] = fetchChunk.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    fetchChunk.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    expect(await probeChunk(url)).toBe("down");
  });

  it("probes the chunk the browser names as failed (a dependency), else the one asked for", () => {
    expect(failedChunkUrl(new TypeError(`Failed to fetch dynamically imported module: ${location.origin}/assets/MapCanvas-X1.js`))).toBe("/assets/MapCanvas-X1.js");
    expect(failedChunkUrl(new TypeError("Failed to fetch dynamically imported module: https://elsewhere.example/assets/a.js"))).toBeUndefined();
    expect(failedChunkUrl(safariMiss())).toBeUndefined();
  });

  it("gone from the server (a deploy): reloads once, as before", async () => {
    fetchChunk.mockResolvedValue(new Response("Not found", { status: 404 }));
    Sheet("en", failing());
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("back online, a reload just happened and the chunk is gone from the server: Skald was updated after all", async () => {
    afterReload();
    onLine = false;
    Sheet("en", failing());
    await screen.findByRole("alert");
    fetchChunk.mockResolvedValue(new Response("Not found", { status: 404 }));
    onLine = true;
    act(() => void window.dispatchEvent(new Event("online")));
    await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(en["crash.stale"]));
    expect(reload).not.toHaveBeenCalled();
  });

  it("back online but a reload just happened: the general note, not the update one, and the reload once the guard allows", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      afterReload();
      onLine = false;
      Sheet("en", failing());
      await vi.waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
      onLine = true;
      act(() => void window.dispatchEvent(new Event("online")));
      await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(en["crash.body"]));
      expect(reload).not.toHaveBeenCalled();
      await act(async () => void (await vi.advanceTimersByTimeAsync(80_000)));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps failing while the server has it: stops after two reloads in five minutes instead of reloading every minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      // A reload, then a second one a minute later: as many as five minutes allow.
      afterReload();
      vi.advanceTimersByTime(61_000);
      afterReload();
      Sheet("en", failing());
      await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(en["crash.body"]));
      const calls = fetchChunk.mock.calls.length;
      await act(async () => void (await vi.advanceTimersByTimeAsync(10 * 60_000)));
      expect(reload).not.toHaveBeenCalled();
      expect(fetchChunk.mock.calls.length).toBe(calls);
      expect(screen.getByRole("alert")).toHaveTextContent(en["crash.body"]);
      // The card's own button still reloads.
      fireEvent.click(screen.getByRole("button", { name: en["crash.reload"] }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails again right after the reload while the server has it: not called an update, reloads once the guard allows (EN and PL)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      afterReload();
      const view = Sheet("en", failing());
      await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(en["crash.body"]));
      expect(screen.getByRole("alert")).not.toHaveTextContent(en["crash.stale"]);
      expect(reload).not.toHaveBeenCalled();
      // While the guard holds, the checks do not download the chunk again.
      const calls = fetchChunk.mock.calls.length;
      await act(async () => void (await vi.advanceTimersByTimeAsync(50_000)));
      expect(fetchChunk.mock.calls.length).toBe(calls);
      await act(async () => void (await vi.advanceTimersByTimeAsync(80_000)));
      expect(reload).toHaveBeenCalledTimes(1);
      view.unmount();

      page.reloading = false;
      reload.mockClear();
      afterReload();
      Sheet("pl", failing());
      await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(pl["crash.body"]));
      expect(screen.getByRole("alert")).not.toHaveTextContent(pl["crash.stale"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("lazyChunk call sites", () => {
  // The build lists each lazy chunk under its module's file name; a name that does not match finds no URL.
  it("name each chunk after the module they import", () => {
    const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.*"], { query: "?raw", import: "default", eager: true });
    const sites = Object.values(sources).flatMap((text) => [...text.matchAll(/lazyChunk(?:<[^>]*>)?\(\s*\(\)\s*=>\s*import\("([^"]+)"\),\s*"([^"]+)"\)/g)]);
    expect(sites.length).toBeGreaterThanOrEqual(5);
    for (const [, path, name] of sites) expect(name).toBe(path!.slice(path!.lastIndexOf("/") + 1));
    expect(new Set(sites.map((m) => m[2])).size).toBe(sites.length);
  });
});
