import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localePreloadScript } from "./preload";

// test-setup registers both dictionaries on the shared modules. These tests
// import fresh copies, which start with none, the way the browser does.
const fresh = async () => {
  vi.resetModules();
  const load = await import("./load");
  const i18n = await import("./index");
  const storage = await import("../lib/storage");
  return { load, i18n, storage };
};

describe("dictionary chunks", () => {
  it("are not part of the i18n module: nothing is loaded until asked for", async () => {
    const { load } = await fresh();
    expect(load.dictFor("en")).toBeUndefined();
    expect(load.dictFor("pl")).toBeUndefined();
    expect(load.loadedDicts()).toEqual([]);
  });

  it("loads one language on demand, once", async () => {
    const { load } = await fresh();
    const a = load.loadLocale("pl");
    const b = load.loadLocale("pl");
    const pl = await a;
    expect(await b).toBe(pl);
    expect(pl["login.submit"]).toBe("Rozpal");
    expect(load.dictFor("en")).toBeUndefined();
  });

  it("I18nProvider shows the fallback until the dictionary is in, then the language", async () => {
    const { i18n } = await fresh();
    const Probe = () => <p>{i18n.useI18n().t("login.submit")}</p>;
    render(
      <i18n.I18nProvider locale="pl" fallback={<p>waiting</p>}>
        <Probe />
      </i18n.I18nProvider>,
    );
    expect(screen.getByText("waiting")).toBeInTheDocument();
    expect(await screen.findByText("Rozpal")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("pl");
  });

  it("keeps the old language up while the new one loads, then switches", async () => {
    const { i18n, load } = await fresh();
    await load.loadLocale("pl");
    const Probe = () => {
      const { t, setLocale } = i18n.useI18n();
      return (
        <button type="button" onClick={() => setLocale("en")}>
          {t("login.submit")}
        </button>
      );
    };
    render(
      <i18n.I18nProvider locale="pl" fallback={<p>waiting</p>}>
        <Probe />
      </i18n.I18nProvider>,
    );
    act(() => fireEvent.click(screen.getByRole("button", { name: "Rozpal" })));
    // No blank frame and no half-switched state: Polish until English is in.
    expect(screen.queryByText("waiting")).toBeNull();
    expect(screen.getByRole("button", { name: "Rozpal" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Kindle" })).toBeInTheDocument();
  });

  it("a switch whose chunk fails to load keeps the language on screen and is not remembered", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem, removeItem: () => undefined });
    vi.doMock("./en", () => {
      throw new Error("offline");
    });
    try {
      const { i18n, load } = await fresh();
      await load.loadLocale("pl");
      const Probe = () => {
        const { t, setLocale } = i18n.useI18n();
        return (
          <button type="button" onClick={() => setLocale("en")}>
            {t("login.submit")}
          </button>
        );
      };
      render(
        <i18n.I18nProvider locale="pl">
          <Probe />
        </i18n.I18nProvider>,
      );
      act(() => fireEvent.click(screen.getByRole("button", { name: "Rozpal" })));
      await expect(load.loadLocale("en")).rejects.toThrow();
      await act(async () => undefined);
      expect(screen.getByRole("button", { name: "Rozpal" })).toBeInTheDocument();
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("./en");
      vi.unstubAllGlobals();
    }
  });

  describe("after a failed download", () => {
    // In a browser a failed `import()` stays failed for the page: the mocked `./en` keeps throwing, like that.
    const served = { en: "/assets/en-T1.js", pl: "/assets/pl-T2.js" };
    beforeEach(() => {
      vi.stubGlobal("__skaldChunks", served);
      vi.doMock("./en", () => {
        throw new TypeError("Failed to fetch dynamically imported module: http://127.0.0.1/assets/en-T1.js");
      });
    });
    afterEach(() => {
      vi.doUnmock("./en");
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });
    const real = async () => (await vi.importActual<typeof import("./en")>("./en")).en;

    it("the first load asks again under a fresh URL and the page comes up", async () => {
      const { i18n, load } = await fresh();
      const urls: string[] = [];
      const en = await real();
      load.chunkImport.load = async (url) => {
        urls.push(url);
        return { en };
      };
      const Probe = () => <p>{i18n.useI18n().t("login.submit")}</p>;
      render(
        <i18n.I18nProvider locale="en" fallback={<p>waiting</p>}>
          <Probe />
        </i18n.I18nProvider>,
      );
      expect(await screen.findByText("Kindle")).toBeInTheDocument();
      expect(urls).toEqual(["/assets/en-T1.js?retry=1"]);
    });

    it("the toggle pressed offline does nothing, and the next press back online switches", async () => {
      let onLine = false;
      vi.spyOn(navigator, "onLine", "get").mockImplementation(() => onLine);
      const { i18n, load } = await fresh();
      await load.loadLocale("pl");
      const en = await real();
      const urls: string[] = [];
      load.chunkImport.load = async (url) => {
        urls.push(url);
        if (!onLine) throw new TypeError("Importing a module script failed.");
        return { en };
      };
      const Probe = () => {
        const { t, setLocale } = i18n.useI18n();
        return (
          <button type="button" onClick={() => setLocale("en")}>
            {t("login.submit")}
          </button>
        );
      };
      render(
        <i18n.I18nProvider locale="pl">
          <Probe />
        </i18n.I18nProvider>,
      );
      act(() => fireEvent.click(screen.getByRole("button", { name: "Rozpal" })));
      await act(async () => undefined);
      expect(screen.getByRole("button", { name: "Rozpal" })).toBeInTheDocument();
      onLine = true;
      act(() => fireEvent.click(screen.getByRole("button", { name: "Rozpal" })));
      expect(await screen.findByRole("button", { name: "Kindle" })).toBeInTheDocument();
      // Every try after the first failure is a URL no failure is cached under.
      expect(new Set(urls).size).toBe(urls.length);
      expect(urls.at(-1)).toMatch(/^\/assets\/en-T1\.js\?retry=\d+$/);
    });

    it("a dictionary gone after a deploy reloads the page once, in the language asked for", async () => {
      const store = new Map<string, string>();
      vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: () => undefined });
      const session = new Map<string, string>();
      vi.stubGlobal("sessionStorage", { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v) });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", { status: 404 })));
      const { i18n, load } = await fresh();
      const chunks = await import("../lib/chunks");
      const reload = vi.fn();
      chunks.page.reload = reload;
      chunks.page.reloading = false;
      await load.loadLocale("pl");
      load.chunkImport.load = async () => {
        throw new TypeError("Importing a module script failed.");
      };
      const Probe = () => {
        const { t, setLocale } = i18n.useI18n();
        return (
          <button type="button" onClick={() => setLocale("en")}>
            {t("login.submit")}
          </button>
        );
      };
      render(
        <i18n.I18nProvider locale="pl">
          <Probe />
        </i18n.I18nProvider>,
      );
      act(() => fireEvent.click(screen.getByRole("button", { name: "Rozpal" })));
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(store.get("skald_locale")).toBe("en");
    });
  });

  it("item search matches the other language once its dictionary arrives", async () => {
    const { load, storage } = await fresh();
    await load.loadLocale("en");
    const entries = [{ name: "Iron", label: "Iron", category: "metal" as const, total: 1, places: [] }];
    expect(storage.searchStore(entries, "zelazo")).toEqual([]);
    await load.loadLocale("pl");
    expect(storage.searchStore(entries, "zelazo").map((e) => e.name)).toEqual(["Iron"]);
  });
});

describe("locale preload script", () => {
  const chunks = { en: "/assets/en-A1.js", pl: "/assets/pl-B2.js" };
  const store = new Map<string, string>();
  const run = () => new Function(localePreloadScript(chunks))();
  const preloads = () => [...document.head.querySelectorAll('link[rel="modulepreload"]')].map((l) => l.getAttribute("href"));

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const l of document.head.querySelectorAll('link[rel="modulepreload"]')) l.remove();
    document.documentElement.removeAttribute("data-locale");
    document.documentElement.lang = "en";
  });

  it("preloads the server default when the viewer has no choice stored", () => {
    document.documentElement.setAttribute("data-locale", "pl");
    run();
    expect(preloads()).toEqual(["/assets/pl-B2.js"]);
    expect(document.documentElement.lang).toBe("pl");
  });

  it("preloads the viewer's stored choice over the server default", () => {
    document.documentElement.setAttribute("data-locale", "pl");
    store.set("skald_locale", "en");
    run();
    expect(preloads()).toEqual(["/assets/en-A1.js"]);
  });

  it("ignores a stored value that is not a language, and does nothing without a default", () => {
    store.set("skald_locale", "toString");
    run();
    expect(preloads()).toEqual([]);
    document.documentElement.setAttribute("data-locale", "en");
    run();
    expect(preloads()).toEqual(["/assets/en-A1.js"]);
  });

  it("publishes every lazy chunk's URL for retries, before and regardless of the language", () => {
    const lazy = { MapView: "/assets/MapView-C3.js", en: "/assets/en-A1.js", pl: "/assets/pl-B2.js" };
    new Function(localePreloadScript(chunks, lazy))();
    expect((window as unknown as Record<string, unknown>).__skaldChunks).toEqual(lazy);
    // A stored value naming a lazy chunk is still not a language.
    store.set("skald_locale", "MapView");
    document.documentElement.setAttribute("data-locale", "pl");
    new Function(localePreloadScript(chunks, lazy))();
    expect(preloads()).toEqual(["/assets/pl-B2.js"]);
    delete (window as unknown as Record<string, unknown>).__skaldChunks;
  });

  it("still works when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    document.documentElement.setAttribute("data-locale", "pl");
    run();
    expect(preloads()).toEqual(["/assets/pl-B2.js"]);
  });
});
