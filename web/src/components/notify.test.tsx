import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import NotifySheet from "./NotifySheet";
import { Preferences } from "./Preferences";

// A browser with push: a service worker, a push manager and the permission prompt.
interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer };
  toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: () => Promise<boolean>;
}

const PUBLIC_KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/ragnar-phone";

function browser(o: { permission?: NotificationPermission; subscribed?: boolean } = {}) {
  let sub: FakeSub | null = null;
  const makeSub = (key: ArrayBuffer): FakeSub => ({
    endpoint: ENDPOINT,
    options: { applicationServerKey: key },
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn(async () => ((sub = null), true)),
  });
  const subscribe = vi.fn(async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => (sub = makeSub(applicationServerKey.buffer as ArrayBuffer)));
  const reg = { pushManager: { getSubscription: async () => sub, subscribe } };
  vi.stubGlobal("PushManager", class {});
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => reg, ready: Promise.resolve(reg) } });
  const requestPermission = vi.fn(async () => o.permission ?? "granted");
  vi.stubGlobal("Notification", { permission: o.permission === "denied" ? "denied" : "default", requestPermission });
  if (o.subscribed) sub = makeSub(new ArrayBuffer(65));
  const calls: { method: string; path: string; body: unknown }[] = [];
  let stored: unknown = o.subscribed ? { kinds: ["raid"], firstJoinOnly: false, quiet: null, timeZone: "UTC", locale: "en" } : null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init.method ?? "GET", path, body });
      if (path === "/api/push" && (init.method ?? "GET") === "GET") return Response.json({ ok: true, publicKey: PUBLIC_KEY, kinds: [] });
      if (path === "/api/push/device") return Response.json({ ok: true, prefs: stored });
      if (path === "/api/push" && init.method === "PUT") {
        stored = body.prefs;
        return Response.json({ ok: true, prefs: body.prefs });
      }
      return Response.json({ ok: true });
    }),
  );
  return { calls, subscribe, requestPermission, sub: () => sub };
}

const sheet = (locale: "en" | "pl" = "en") =>
  render(
    <I18nProvider locale={locale}>
      <NotifySheet onClose={() => undefined} />
    </I18nProvider>,
  );

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

describe("the Settings row", () => {
  it("opens notifications and says what an iPhone needs, in both languages", () => {
    const { unmount } = render(
      <I18nProvider locale="en">
        <Preferences onLogout={async () => "ok" as const} />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: /Notifications/ })).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.getByText("On this device. iPhone: add the panel to the Home Screen first.")).toBeInTheDocument();
    unmount();
    render(
      <I18nProvider locale="pl">
        <Preferences onLogout={async () => "ok" as const} />
      </I18nProvider>,
    );
    expect(screen.getByText("Na tym urządzeniu. iPhone: najpierw dodaj panel do ekranu początkowego.")).toBeInTheDocument();
  });
});

describe("NotifySheet", () => {
  it("on an iPhone in Safari, explains the Home Screen instead of a switch", () => {
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5 });
    sheet();
    expect(screen.getByText(/only reach the panel on the Home Screen \(iOS 16.4 or later\)/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("says so where there is no push at all", () => {
    sheet("pl");
    expect(screen.getByText("Ta przeglądarka nie odbiera powiadomień z panelu.")).toBeInTheDocument();
  });

  it("asks for permission first, subscribes with the panel's key and saves the default choice", async () => {
    const b = browser();
    sheet();
    const device = await screen.findByRole("switch", { name: "Notifications on this device" });
    expect(device).toHaveAttribute("aria-checked", "false");
    await act(async () => fireEvent.click(device));
    await waitFor(() => expect(device).toHaveAttribute("aria-checked", "true"));
    expect(b.requestPermission).toHaveBeenCalledBefore(b.subscribe);
    const key = new Uint8Array(b.sub()!.options.applicationServerKey);
    expect(key.length).toBe(65);
    expect(key[0]).toBe(4);
    const put = b.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ subscription: { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } }, prefs: { kinds: ["join", "server", "boss", "raid"], firstJoinOnly: false, quiet: null, locale: "en" } });
    expect(screen.getByRole("switch", { name: "A friend joins" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Someone falls" })).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("skald_push_on")).toBe("1");
  });

  it("shows what the server keeps for this device and saves each change at once", async () => {
    const b = browser({ subscribed: true });
    sheet();
    const raid = await screen.findByRole("switch", { name: "A raid starts" });
    expect(raid).toHaveAttribute("aria-checked", "true");
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Someone falls" })));
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" })));
    const puts = b.calls.filter((c) => c.method === "PUT").map((c) => c.body as { prefs: { kinds: string[]; quiet: unknown } });
    expect(puts[0]!.prefs.kinds).toEqual(["raid", "death"]);
    expect(puts[1]!.prefs.quiet).toEqual({ from: "22:00", to: "07:00" });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "23:15" } });
    await waitFor(() => expect(b.calls.filter((c) => c.method === "PUT")).toHaveLength(3));
    expect((b.calls.at(-1)!.body as { prefs: { quiet: unknown } }).prefs.quiet).toEqual({ from: "23:15", to: "07:00" });
  });

  it("turns off: forgets the device on the server and unsubscribes the browser", async () => {
    const b = browser({ subscribed: true });
    const sub = b.sub()!;
    sheet();
    const device = await screen.findByRole("switch", { name: "Notifications on this device" });
    await waitFor(() => expect(device).toHaveAttribute("aria-checked", "true"));
    await act(async () => fireEvent.click(device));
    await waitFor(() => expect(device).toHaveAttribute("aria-checked", "false"));
    expect(b.calls.find((c) => c.method === "DELETE")!.body).toEqual({ endpoint: ENDPOINT });
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it("says so when the server keeps no more devices, and drops the browser's subscription", async () => {
    const b = browser();
    const fetchImpl = globalThis.fetch;
    vi.stubGlobal("fetch", async (path: string, init: RequestInit = {}) => (path === "/api/push" && init.method === "PUT" ? Response.json({ ok: false, error: "session_full" }, { status: 409 }) : fetchImpl(path, init)));
    sheet();
    const device = await screen.findByRole("switch", { name: "Notifications on this device" });
    await act(async () => fireEvent.click(device));
    await screen.findByText(/Too many devices have notifications on/);
    expect(device).toHaveAttribute("aria-checked", "false");
    expect(b.sub()).toBeNull();
  });

  it("keeps the browser's subscription when the server is only busy", async () => {
    const b = browser();
    const fetchImpl = globalThis.fetch;
    vi.stubGlobal("fetch", async (path: string, init: RequestInit = {}) => (path === "/api/push" && init.method === "PUT" ? Response.json({ ok: false }, { status: 429 }) : fetchImpl(path, init)));
    sheet();
    const device = await screen.findByRole("switch", { name: "Notifications on this device" });
    await act(async () => fireEvent.click(device));
    await screen.findByText("That did not work. Try again in a moment.");
    expect(b.sub()).not.toBeNull();
  });

  it("explains a refused permission and stays off", async () => {
    const b = browser({ permission: "denied" });
    sheet();
    const device = await screen.findByRole("switch", { name: "Notifications on this device" });
    await act(async () => fireEvent.click(device));
    expect(device).toHaveAttribute("aria-checked", "false");
    expect(b.subscribe).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Notifications are blocked for this site/).length).toBeGreaterThan(0);
  });
});
