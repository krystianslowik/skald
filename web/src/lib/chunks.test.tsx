import { fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChunkBoundary } from "../components/ErrorBoundary";
import { I18nProvider } from "../i18n";
import { en } from "../i18n/en";
import { pl } from "../i18n/pl";
import { isChunkError, lazyChunk, page, reloadOnce } from "./chunks";

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
  const failing = (err: Error) => lazyChunk<object>(() => Promise.reject(err));
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
