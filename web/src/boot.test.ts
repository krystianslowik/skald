// Runs the boot watchdog from index.html: a page whose app script never ran
// (Safari kept a load that failed offline) must not stay blank.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HTML from "../index.html?raw";

const SOURCE = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "").find((s) => s.includes("Boot watchdog"));

type Listener = (e: Event) => void;

let listeners: Map<string, Listener>;
let reload: ReturnType<typeof vi.fn<() => void>>;
let fetchAsset: ReturnType<typeof vi.fn>;
let store: Map<string, string>;

/** One page load: the watchdog's script runs with its own listeners and `location.reload`. */
function boot() {
  const add = (type: string, fn: Listener) => void listeners.set(type, fn);
  const loc = { href: location.href, origin: location.origin, reload };
  new Function("addEventListener", "location", SOURCE ?? "")(add, loc);
}

const entryFailed = () => {
  const script = document.head.querySelector<HTMLScriptElement>('script[type="module"]')!;
  listeners.get("error")?.({ target: script } as unknown as Event);
};
const note = () => document.getElementById("skald-boot");
const settle = () => vi.waitFor(() => expect(note()?.querySelector("button")?.textContent).toMatch(/^(Reload|Odśwież)$/));

beforeEach(() => {
  listeners = new Map();
  reload = vi.fn<() => void>();
  fetchAsset = vi.fn(async () => new Response("export {}", { status: 200 }));
  vi.stubGlobal("fetch", fetchAsset);
  store = new Map();
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  document.documentElement.lang = "en";
  document.documentElement.removeAttribute("data-booted");
  document.head.insertAdjacentHTML(
    "beforeend",
    '<script type="module" data-t src="/assets/index-H1.js"></script><link data-t rel="modulepreload" href="/assets/Sheet-J2.js"><link data-t rel="modulepreload" href="https://elsewhere.example/assets/x.js">',
  );
});
afterEach(() => {
  document.head.querySelectorAll("[data-t]").forEach((el) => el.remove());
  note()?.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("boot watchdog", () => {
  it("is in the page", () => {
    expect(SOURCE).toBeTruthy();
  });

  it("the app script failed: says so, fetches the page's scripts again, then reloads once", async () => {
    boot();
    entryFailed();
    expect(note()).toHaveTextContent("Skald could not start");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(fetchAsset.mock.calls.map(([u]) => u).sort()).toEqual(["/assets/Sheet-J2.js", "/assets/index-H1.js"]);
  });

  it("does not reload while a script cannot be fetched, and keeps the note with a Reload button", async () => {
    fetchAsset.mockImplementation(async (u: string) => {
      if (u === "/assets/index-H1.js") throw new TypeError("Load failed");
      return new Response("export {}", { status: 200 });
    });
    boot();
    entryFailed();
    await settle();
    expect(reload).not.toHaveBeenCalled();
    fetchAsset.mockResolvedValue(new Response("export {}", { status: 200 }));
    note()!.querySelector("button")!.click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("reloads when a script answers 404: a newer build, which the reload fetches", async () => {
    fetchAsset.mockResolvedValue(new Response("Not found", { status: 404 }));
    boot();
    entryFailed();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("does not reload offline, where the cache answers but the page would fail again", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    boot();
    entryFailed();
    await settle();
    expect(reload).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("reloads on its own once a minute at most, so a broken build cannot loop", async () => {
    boot();
    entryFailed();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    note()?.remove();
    // The reloaded page fails again at once.
    boot();
    entryFailed();
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(note()).toHaveTextContent("Skald could not start");
  });

  it("speaks Polish on a Polish page", () => {
    document.documentElement.lang = "pl";
    boot();
    entryFailed();
    expect(note()).toHaveTextContent("Skald nie mógł się uruchomić");
  });

  it("stays out of the way once the app ran", () => {
    vi.useFakeTimers();
    boot();
    document.documentElement.setAttribute("data-booted", "");
    listeners.get("load")?.(new Event("load"));
    vi.advanceTimersByTime(10_000);
    entryFailed();
    expect(note()).toBeNull();
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it("notices a page that never started even without an error event", () => {
    vi.useFakeTimers();
    boot();
    listeners.get("load")?.(new Event("load"));
    vi.advanceTimersByTime(3000);
    expect(note()).toHaveTextContent("Skald could not start");
  });
});
