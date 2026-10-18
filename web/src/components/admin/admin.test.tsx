import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";
import { describeAdmin } from "../Saga";
import { I18nProvider, LocaleToggle, makeI18n } from "../../i18n";
import { FillSheet, fillResult } from "./FillSheet";
import { ItemPicker } from "./ItemPicker";
import { Glide } from "../../lib/live";
import { createLogStore } from "../../lib/useValheim";
import { preloadLazyChunks } from "../../test-preload";
import { emptyAgentState, NOTIFY_KINDS, type AccessState, type AdminStatus, type AgentEvent, type ApiState, type NotifyConfig, type RestoreInfo } from "../../types";
import { restoreProgress, RestoreSheet } from "./WorldTools";
import { AdminProvider, useAdmin, type Admin } from "./AdminContext";
import { BRIDGE_PLUGIN_VERSION } from "@server/bridgeplugin";

function fixture(): ApiState {
  const s = emptyAgentState(new Date("2026-10-09T20:00:00Z"));
  s.server = { ...s.server, name: "My Valheim", world: "Midgard", status: "running", version: "l-1.0.17" };
  s.players = [
    { name: "Ragnar", since: "2026-10-09T19:30:00Z", platform: "xbox" },
    { name: "Freya", since: "2026-10-09T19:40:00Z", platform: "steam" },
  ];
  return { ...s, online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } };
}

function status(over: Partial<AdminStatus> = {}, bridge: Partial<AdminStatus["bridge"]> = {}): AdminStatus {
  return {
    required: false,
    unlocked: true,
    idleMs: 1_800_000,
    notifyConfigured: false,
    ...over,
    bridge: { available: true, plugin: BRIDGE_PLUGIN_VERSION, gameBuild: "l-1.0.17", worldLoaded: true, timeFrozen: false, tested: true, acknowledged: false, testedBuilds: ["l-1.0.17"], commands: [], ...bridge },
  };
}

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };

// Fictional ids and names only.
const ACCESS: AccessState = {
  writable: true,
  running: true,
  admins: { entries: [{ id: "X_1234500000000001", platform: "xbox", name: "Ragnar", known: true }], live: false },
  bans: { entries: [{ id: "Steam_76561190000000009", platform: "steam", known: true }], live: true },
  online: [
    { name: "Ragnar", platform: "xbox", admin: true, banned: false, canAdd: true },
    { name: "Freya", platform: "steam", admin: false, banned: false, canAdd: true },
  ],
};

const RESTORE: RestoreInfo = {
  world: "Midgard",
  running: false,
  playersOnline: false,
  backups: [
    { name: "pre-restore-20261009-190000.zip", source: "skald", sizeBytes: 2_000_000, modifiedAt: "2026-10-09T19:00:00Z" },
    { name: "worlds-20261009-180000.zip", source: "image", sizeBytes: 1_900_000, modifiedAt: "2026-10-09T18:00:00Z" },
  ],
};

const STATIONS = {
  kilns: [{ prefab: "charcoal_kiln", inputs: ["Wood"] }],
  smelters: [
    { prefab: "smelter", fuel: "Coal", inputs: ["CopperOre", "IronScrap"] },
    { prefab: "blastfurnace", fuel: "Coal", inputs: ["BlackMetalScrap"] },
  ],
  fermenters: [{ prefab: "fermenter", inputs: ["MeadBaseTasty", "MeadBaseHealthMinor"] }],
};

/** The panel's API as far as these tests need it; everything else 404s. */
function api(st: AdminStatus, commands: (url: string, n: number) => Response = () => Response.json({ ok: true, data: {} }), notify?: (method: string, body: unknown) => Response) {
  const calls: Call[] = [];
  let n = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
    if (u === "/api/admin/status") return Response.json(st);
    if (u === "/api/admin/catalog") return Response.json({ events: ["wolves"], currentEvent: null, globalKeys: ["defeated_eikthyr"], spots: ["spawn"], stations: STATIONS });
    if (u === "/api/admin/read/bans") return Response.json({ ok: true, data: [] });
    if (u === "/api/admin/access" && method === "GET") return Response.json({ ok: true, data: ACCESS });
    if (u === "/api/admin/restore" && method === "GET") return Response.json({ ok: true, data: RESTORE });
    if (u === "/api/admin/unlock") return Response.json({ ok: true });
    if (u === "/api/admin/notify" && notify) return notify(method, init?.body ? JSON.parse(String(init.body)) : undefined);
    if (u.startsWith("/api/admin/") && method === "POST") return commands(u, n++);
    if (u === "/api/notify/test" && method === "POST") return commands(u, n++);
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const renderDashboard = () => render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={async () => "ok" as const} />);

async function openAdmin() {
  const button = await screen.findByRole("button", { name: "Admin" });
  fireEvent.click(button);
  return screen.findByRole("dialog", { name: "Admin" });
}

beforeAll(preloadLazyChunks);

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("admin", () => {

  it("updates default kit names when the language changes", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
    api(status());
    render(<I18nProvider locale="en"><LocaleToggle /><ItemPicker target={{ at: { x: 0, z: 0 } }} onClose={() => {}} /></I18nProvider>);
    expect(screen.getByRole("button", { name: "Starter7" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bronze age6" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Boss prep5" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zmień język na Polski" }));
    expect(screen.getByRole("button", { name: "Na początek7" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Epoka brązu6" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Przygotowanie do bossa5" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Starter7" })).not.toBeInTheDocument();
  });

  it("never offers items the game marks as unused, in either language", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
    api(status());
    render(<I18nProvider locale="en"><LocaleToggle /><ItemPicker target={{ at: { x: 0, z: 0 } }} onClose={() => {}} /></I18nProvider>);
    const results = () => screen.getByRole("list", { name: "Items" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "shield" } });
    expect(within(results()).getByRole("button", { name: /Iron Shield/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "knight" } });
    expect(within(results()).queryByRole("button", { name: /UNUSED/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zmień język na Polski" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unused" } });
    expect(screen.queryByRole("button", { name: /UNUSED/ })).not.toBeInTheDocument();
  });

  it("preserves user kit names when the language changes", () => {
    const kits = [{ name: "Starter", lines: [{ item: "Wood", amount: 50, quality: 1 }] }];
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === "skald.admin.kits" ? JSON.stringify(kits) : null, setItem: vi.fn() });
    api(status());
    render(<I18nProvider locale="en"><LocaleToggle /><ItemPicker target={{ at: { x: 0, z: 0 } }} onClose={() => {}} /></I18nProvider>);
    expect(screen.getByRole("button", { name: "Starter1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zmień język na Polski" }));
    expect(screen.getByRole("button", { name: "Starter1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usuń zestaw Starter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Na początek7" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Usuń zestaw Na początek" })).not.toBeInTheDocument();
  });

  it("keeps default kits available after saving and deleting a custom kit", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) });
    api(status());
    render(<I18nProvider locale="en"><ItemPicker target={{ at: { x: 0, z: 0 } }} onClose={() => {}} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Starter7" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as kit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Kit name" }), { target: { value: "My supplies" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "My supplies7" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Starter7" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prep: Moder15" })).toBeInTheDocument();
    const saved = JSON.parse(store.get("skald.admin.kits")!);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("My supplies");
    expect(saved[0]).not.toHaveProperty("nameKey");
    expect(screen.queryByRole("button", { name: "Delete kit Starter" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete kit My supplies" }));
    expect(screen.queryByRole("button", { name: "My supplies7" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Starter7" })).toBeInTheDocument();
    expect(JSON.parse(store.get("skald.admin.kits")!)).toEqual([]);
  });

  it("sends a Discord test notification and never shows the webhook", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    const calls = api(status({ notifyConfigured: true }));
    renderDashboard();
    const dialog = await openAdmin();
    expect(within(dialog).getByText(/go to a Discord channel/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send a test notification" }));
    expect(await screen.findByText("Test notification sent.")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/notify/test" && c.method === "POST")).toHaveLength(1);
  });

  it("says to wait when a test message was just sent", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    api(status({ notifyConfigured: true }), () => Response.json({ ok: false, error: "busy" }, { status: 429, headers: { "Retry-After": "8" } }));
    renderDashboard();
    const dialog = await openAdmin();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send a test notification" }));
    expect(await screen.findByText("A test message was just sent. Try again in a few seconds.")).toBeInTheDocument();
  });

  it.each([
    ["Discord's rate limit, with its wait", () => Response.json({ ok: false, error: "rate_limited", retryAfter: 27 }, { status: 429, headers: { "Retry-After": "27" } }), /^Discord asked to slow down\. Try again in 27\ss\.$/],
    ["the origin check, without blaming Discord", () => Response.json({ ok: false, error: "cross_origin", message: "request from another origin refused" }, { status: 403 }), "The server refused this address. Its operator needs to set PUBLIC_ORIGIN to the address you opened the panel on."],
    ["a proxy's error page as no connection", () => new Response("<h1>Bad Gateway</h1>", { status: 502 }), "No connection. Try again in a moment."],
  ])("names %s after a test", async (_, answer, text) => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    api(status({ notifyConfigured: true }), answer);
    renderDashboard();
    const dialog = await openAdmin();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send a test notification" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("says how to turn Discord notifications on when they are off", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    api(status(), undefined, () => Response.json({ ok: true, source: "panel", masked: null, enabled: true, kinds: [...NOTIFY_KINDS] }));
    renderDashboard();
    const dialog = await openAdmin();
    expect(await within(dialog).findByText(/Paste a Discord channel webhook/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Send a test notification" })).not.toBeInTheDocument();
  });

  it("saves a webhook, then shows only its masked form, and picks what goes out", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    const token = "Zx9-fictional-token-for-Astrid_000000000000000000000000000000000000";
    const hook = `https://discord.com/api/webhooks/123456789012345678/${token}`;
    let cfg: NotifyConfig = { source: "panel", masked: null, enabled: true, kinds: [...NOTIFY_KINDS] };
    const calls = api(status(), undefined, (method, body) => {
      if (method === "GET") return Response.json({ ok: true, ...cfg });
      const b = body as { url?: string; enabled?: boolean; kinds?: NotifyConfig["kinds"] };
      if (b.url !== undefined && b.url !== hook) return Response.json({ ok: false, error: "bad_url" }, { status: 400 });
      cfg = { ...cfg, ...(b.url ? { masked: "discord.com/api/webhooks/…5678/Zx9-…" } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.kinds ? { kinds: b.kinds } : {}) };
      return Response.json({ ok: true, ...cfg });
    });
    renderDashboard();
    const dialog = await openAdmin();
    const field = await within(dialog).findByLabelText("Webhook URL");
    fireEvent.change(field, { target: { value: "https://example.com/hook" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save webhook" }));
    expect(await within(dialog).findByText(/not a Discord webhook URL/)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: hook } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save webhook" }));
    expect(await within(dialog).findByText("discord.com/api/webhooks/…5678/Zx9-…")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(token);
    expect(calls.filter((c) => c.url === "/api/admin/notify" && c.method === "PUT").map((c) => c.body)).toEqual([{ url: "https://example.com/hook" }, { url: hook }]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Deaths" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Deaths" })).toHaveAttribute("aria-pressed", "false"));
    expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ kinds: NOTIFY_KINDS.filter((k) => k !== "death") });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send notifications" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Send notifications" })).toHaveAttribute("aria-pressed", "false"));
    expect(calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({ enabled: false });
    expect(within(dialog).getByRole("button", { name: "Raids" })).toBeDisabled();
  });

  it("shows a webhook from the environment read-only", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    const calls = api(status({ notifyConfigured: true }), undefined, () => Response.json({ ok: true, source: "env", masked: "discord.com/api/webhooks/…4321/AbCd…", enabled: true, kinds: ["join_code"] }));
    renderDashboard();
    const dialog = await openAdmin();
    expect(await within(dialog).findByText(/Set by the server environment/)).toBeInTheDocument();
    expect(within(dialog).getByText("discord.com/api/webhooks/…4321/AbCd…")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(within(within(dialog).getByRole("region", { name: "Discord" })).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Send notifications" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "New join codes" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Send a test notification" })).toBeEnabled();
    expect(calls.filter((c) => c.url === "/api/admin/notify" && c.method !== "GET")).toHaveLength(0);
  });

  it("does not ask for the Discord settings before the admin unlocks", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    const calls = api(status({ required: true, unlocked: false }), undefined, () => Response.json({ ok: true, source: "panel", masked: null, enabled: true, kinds: [] }));
    renderDashboard();
    const dialog = await openAdmin();
    expect(within(dialog).getByText("Unlock to set the webhook and choose what goes out.")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/admin/notify")).toHaveLength(0);
  });

  it("without a bridge, shows only the Discord status, the lists and backups", async () => {
    api(status({ notifyConfigured: true }, { available: false, reason: "off" }));
    renderDashboard();
    const sheet = await openAdmin();
    expect(within(sheet).queryByRole("textbox", { name: "Broadcast" })).not.toBeInTheDocument();
    expect(within(sheet).getByText(/Without the bridge, live commands are off/)).toBeInTheDocument();
    expect(await within(sheet).findByRole("heading", { name: "Admins and bans" })).toBeInTheDocument();
    expect(within(sheet).getByRole("heading", { name: "Restore a world backup" })).toBeInTheDocument();
    expect(within(sheet).getByText(/go to a Discord channel/)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Send a test notification" })).toBeEnabled();
  });

  it("lists admins and bans, checks a typed id and adds an online player in one tap", async () => {
    const calls = api(status());
    renderDashboard();
    const sheet = await openAdmin();
    // Named where known, the id beside it; an unnamed ban by platform.
    expect(await within(sheet).findByText("X_1234500000000001")).toBeInTheDocument();
    expect(within(sheet).getByText("Unknown player (PC (Steam))")).toBeInTheDocument();
    const input = within(sheet).getByLabelText("Add by platform ID");
    const add = within(sheet).getByRole("button", { name: "Add admin" });
    fireEvent.change(input, { target: { value: "x_12" } });
    expect(within(sheet).getByRole("alert")).toHaveTextContent("F2 panel");
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: "V_76561190000000004" } });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/access/admins/add")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/admin/access/admins/add")!.body).toEqual({ id: "V_76561190000000004" });
    // Ragnar is already an admin; Freya gets the one-tap button.
    expect(within(sheet).getAllByRole("button", { name: "Make admin" })).toHaveLength(1);
    fireEvent.click(within(sheet).getByRole("button", { name: "Make admin" }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/admin/access/admins/add")).toHaveLength(2));
    expect(calls.filter((c) => c.url === "/api/admin/access/admins/add")[1]!.body).toEqual({ player: "Freya" });
  });

  it("keeps the lists and backups closed to a view-only session", async () => {
    const calls = api(status({ required: true, unlocked: false }));
    renderDashboard();
    const sheet = await openAdmin();
    expect(within(sheet).getAllByText("Unlock to see the lists.").length).toBeGreaterThan(0);
    await act(async () => {});
    expect(calls.some((c) => c.url === "/api/admin/access" || c.url === "/api/admin/restore")).toBe(false);
  });

  it("says a session is view-only, with the unlock, before any control", async () => {
    api(status({ required: true, unlocked: false }));
    renderDashboard();
    const sheet = await openAdmin();
    const unlock = within(sheet).getByRole("button", { name: "Unlock" });
    const close = within(sheet).getByRole("button", { name: "Close" });
    const first = within(sheet).getAllByRole("button").find((b) => b !== close && !close.contains(b));
    expect(first).toBe(unlock);
    expect(within(sheet).getByText("View only").compareDocumentPosition(within(sheet).getByRole("textbox", { name: "Broadcast" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sheet).getByText(/the first action asks for it/)).toBeInTheDocument();
    fireEvent.click(unlock);
    expect(await screen.findByRole("dialog", { name: "Unlock" })).toBeInTheDocument();
  });

  it("says view-only first without the bridge too", async () => {
    api(status({ required: true, unlocked: false }, { reason: "off", available: false }));
    renderDashboard();
    const sheet = await openAdmin();
    expect(within(sheet).getByText("View only").compareDocumentPosition(within(sheet).getByText(/Without the bridge/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no view-only banner when the session may command", async () => {
    api(status({ required: true, unlocked: true }));
    renderDashboard();
    const sheet = await openAdmin();
    expect(within(sheet).queryByText("View only")).not.toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Lock" })).toBeInTheDocument();
  });

  it("lists backups with the safety copies marked and opens the restore sheet", async () => {
    api(status());
    renderDashboard();
    const sheet = await openAdmin();
    expect(await within(sheet).findByText("safety copy")).toBeInTheDocument();
    fireEvent.click(within(sheet).getAllByRole("button", { name: "Restore..." })[1]!);
    const restore = await screen.findByRole("dialog", { name: "Restore the world" });
    expect(within(restore).getByText(/will be gone/)).toBeInTheDocument();
  });

  it("shows each backup's full date and time, never clipped", async () => {
    api(status());
    renderDashboard();
    const sheet = await openAdmin();
    await within(sheet).findByText("safety copy");
    const i = makeI18n("en");
    for (const b of RESTORE.backups) {
      const stamp = sheet.querySelector(`time[datetime="${b.modifiedAt}"]`);
      expect(stamp).not.toBeNull();
      expect(stamp).not.toHaveClass("truncate");
      expect(stamp!.textContent).toBe(`${i.date(b.modifiedAt)} ${i.clock(b.modifiedAt)}`);
    }
  });

  it("broadcasts as the narrator, signed with this device's name", async () => {
    const store = new Map([["skald.admin.name", "Łukasz"]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    const calls = api(status());
    renderDashboard();
    const sheet = await openAdmin();
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Broadcast" }), { target: { value: "Boss at nine" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Narrator" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/broadcast")).toBeTruthy());
    const call = calls.find((c) => c.url === "/api/admin/broadcast")!;
    expect(call.body).toEqual({ text: "Boss at nine", type: "narrator" });
    expect(call.headers["X-Skald-Name"]).toBe(encodeURIComponent("Łukasz"));
    expect(await screen.findByText("Message sent.")).toBeInTheDocument();
  });

  it("fills kilns with wood in one tap and says what happened", async () => {
    const calls = api(status(), () => Response.json({ ok: true, data: { kilns: 0, skipped: 0, full: 2, unloaded: 0, added: {} } }));
    renderDashboard();
    const sheet = await openAdmin();
    fireEvent.click(within(sheet).getByRole("button", { name: "Fill kilns with wood" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/fill-kilns")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/admin/fill-kilns")!.body).toMatchObject({ radius: 50 });
    // Not "Filled." when nothing went in.
    expect(await screen.findByText("Nothing went in: the kilns there are already full.")).toBeInTheDocument();
  });

  it("words the fill result after what the bridge did", () => {
    const i = makeI18n("en");
    const p = makeI18n("pl");
    expect(fillResult(i, "fill-smelters", { smelters: 3, skipped: 1 })).toBe("Filled 3 smelters.");
    expect(fillResult(i, "fill-kilns", { kilns: 1 })).toBe("Filled 1 kiln with wood.");
    expect(fillResult(i, "fill-fermenters", { fermenters: 2, full: 1 })).toBe("Started 2 fermenters.");
    expect(fillResult(i, "fill-smelters", { smelters: 0, skipped: 2 })).toBe("Nothing went in: the smelters there are full or do not take that ore.");
    expect(fillResult(i, "fill-fermenters", { fermenters: 0, unloaded: 2 })).toBe("Nothing went in: no player has that place loaded. Someone has to be nearby.");
    expect(fillResult(i, "fill-kilns", {})).toBe("Nothing went in: there are no kilns there.");
    expect(fillResult(p, "fill-smelters", { smelters: 3 })).toBe("Napełniono 3 piece.");
    expect(fillResult(p, "fill-fermenters", { fermenters: 5 })).toBe("Uruchomiono 5 fermentatorów.");
  });

  it("says on screen why Fill kilns, smelters and fermenters are off on an old bridge", async () => {
    api(status({}, { plugin: "0.2.1" }));
    renderDashboard();
    const panel = await openAdmin();
    for (const name of ["Fill kilns with wood", "Fill smelters", "Fill fermenters"]) {
      const b = within(panel).getByRole("button", { name });
      expect(b).toBeDisabled();
      expect(b).toHaveAccessibleDescription("Bridge 0.2.1 cannot fill stations: kilns and smelters need 0.3.0 or later, fermenters 0.4.0.");
    }
    expect(within(panel).getByRole("button", { name: "Repair" })).toBeEnabled();
  });

  it("keeps kilns and smelters on with bridge 0.3.x, and says why fermenters are off", async () => {
    api(status({}, { plugin: "0.3.0" }));
    renderDashboard();
    const panel = await openAdmin();
    expect(within(panel).getByRole("button", { name: "Fill kilns with wood" })).toBeEnabled();
    expect(within(panel).getByRole("button", { name: "Fill smelters" })).toBeEnabled();
    const ferment = within(panel).getByRole("button", { name: "Fill fermenters" });
    expect(ferment).toBeDisabled();
    expect(ferment).toHaveAccessibleDescription("Bridge 0.3.0 cannot fill fermenters: that needs 0.4.0 or later.");
  });

  it("greys out a fill the agent does not list, and says to update the agent", async () => {
    api(status({}, { commands: ["fill-kilns", "fill-smelters", "repair"] }));
    renderDashboard();
    const panel = await openAdmin();
    expect(within(panel).getByRole("button", { name: "Fill smelters" })).toBeEnabled();
    const ferment = within(panel).getByRole("button", { name: "Fill fermenters" });
    expect(ferment).toBeDisabled();
    expect(ferment).toHaveAccessibleDescription("The Skald agent does not know every fill command yet: update the agent.");
  });

  it("still offers keep-current before the catalog is in", () => {
    api(status({ unlocked: false }));
    render(<I18nProvider locale="en"><FillSheet station="smelters" target={{ player: "Ragnar" }} onClose={() => {}} /></I18nProvider>);
    const flow = screen.getByRole("dialog", { name: "Fill smelters" });
    expect(within(flow).getByRole("button", { name: /Keep the current ore/ })).toBeInTheDocument();
  });

  it("offers no keep-current tile when the bridge sent no ore list", () => {
    api(status());
    render(<I18nProvider locale="en"><FillSheet station="smelters" target={{ player: "Ragnar" }} catalog={{ events: [], currentEvent: null, globalKeys: [], spots: [], stations: { kilns: [], smelters: [], fermenters: [] } }} onClose={() => {}} /></I18nProvider>);
    const flow = screen.getByRole("dialog", { name: "Fill smelters" });
    expect(within(flow).queryByRole("button", { name: /Keep the current ore/ })).not.toBeInTheDocument();
    expect(within(flow).getByText(/needs bridge 0\.3\.0 or later/)).toBeInTheDocument();
  });

  it("fills smelters step by step: metal, coal, confirm, result", async () => {
    const calls = api(status(), () => Response.json({ ok: true, data: { smelters: 2, skipped: 1, full: 0, unloaded: 0, added: { IronScrap: 2 }, fuel: "Coal" } }));
    renderDashboard();
    const panel = await openAdmin();
    fireEvent.click(within(panel).getByRole("button", { name: "Fill smelters" }));
    const flow = await screen.findByRole("dialog", { name: "Fill smelters" });
    expect(within(flow).getByText(/Step 1 of 3/)).toBeInTheDocument();
    // Only what some station takes, from the bridge, and keep-current; the station named when there are several kinds.
    const metals = await within(flow).findByRole("list", { name: "Which metal?" });
    const tiles = within(metals).getAllByRole("button").map((b) => b.textContent);
    expect(tiles).toEqual(["Keep the current ore", "CopperSmelter", "Scrap ironSmelter", "Black metal scrapBlast furnace"]);
    fireEvent.click(within(metals).getByRole("button", { name: /Scrap iron/ }));
    // Coal step, then back to the metals with the pick kept.
    expect(within(flow).getByText(/Step 2 of 3/)).toBeInTheDocument();
    fireEvent.click(within(flow).getByRole("button", { name: "Back" }));
    expect(within(flow).getByRole("button", { name: /Scrap iron/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(flow).getByRole("button", { name: /Scrap iron/ }));
    fireEvent.click(within(flow).getByRole("button", { name: "With coal" }));
    expect(within(flow).getByRole("status")).toHaveTextContent("Smelters near Ragnar: scrap iron and coal");
    expect(calls.find((c) => c.url === "/api/admin/fill-smelters")).toBeUndefined();
    fireEvent.click(within(flow).getByRole("button", { name: "Fill smelters" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/fill-smelters")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/admin/fill-smelters")!.body).toEqual({ radius: 50, what: "both", ore: "IronScrap", player: "Ragnar" });
    // What really happened, then back to the panel.
    await waitFor(() => expect(within(flow).getByRole("status")).toHaveTextContent("Filled 2 smelters."));
    fireEvent.click(within(flow).getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("dialog", { name: "Admin" })).toBeInTheDocument();
  });

  it("says in the panel's words why the bridge refused a fill", async () => {
    api(status(), (url) => (url === "/api/admin/fill-smelters" ? Response.json({ ok: false, error: "no connected player 'Ragnar'" }, { status: 404 }) : Response.json({ ok: true, data: {} })));
    renderDashboard();
    const panel = await openAdmin();
    fireEvent.click(within(panel).getByRole("button", { name: "Fill smelters" }));
    const flow = await screen.findByRole("dialog", { name: "Fill smelters" });
    fireEvent.click(within(await within(flow).findByRole("list", { name: "Which metal?" })).getByRole("button", { name: /Scrap iron/ }));
    fireEvent.click(within(flow).getByRole("button", { name: "With coal" }));
    fireEvent.click(within(flow).getByRole("button", { name: "Fill smelters" }));
    expect(await screen.findByText("Ragnar is not in the game any more.")).toBeInTheDocument();
    expect(screen.queryByText(/no connected player/)).not.toBeInTheDocument();
  });

  it("sends coal only without an ore, and keeps the current ore", async () => {
    const calls = api(status());
    renderDashboard();
    const run = async (ore: RegExp, coal: string, summary: string) => {
      const panel = await openAdmin();
      fireEvent.click(within(panel).getByRole("button", { name: "Fill smelters" }));
      const flow = await screen.findByRole("dialog", { name: "Fill smelters" });
      fireEvent.click(await within(flow).findByRole("button", { name: ore }));
      fireEvent.click(within(flow).getByRole("button", { name: coal }));
      expect(within(flow).getByRole("status")).toHaveTextContent(summary);
      fireEvent.click(within(flow).getByRole("button", { name: "Fill smelters" }));
      await within(flow).findByText("Nothing went in: there are no smelters there.");
      fireEvent.click(within(flow).getByRole("button", { name: "Done" }));
      await screen.findByRole("dialog", { name: "Admin" });
      fireEvent.click(within(screen.getByRole("dialog", { name: "Admin" })).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    };
    await run(/Copper/, "Coal only", "Smelters near Ragnar: coal only");
    await run(/Keep the current ore/, "No coal", "Smelters near Ragnar: more of the ore each holds");
    const sent = calls.filter((c) => c.url === "/api/admin/fill-smelters").map((c) => c.body);
    expect(sent).toEqual([
      { radius: 50, what: "coal", player: "Ragnar" },
      { radius: 50, what: "ore", ore: "current", player: "Ragnar" },
    ]);
  });

  it("fills fermenters with a mead base picked from the icons", async () => {
    const calls = api(status());
    renderDashboard();
    const panel = await openAdmin();
    fireEvent.click(within(panel).getByRole("button", { name: "Fill fermenters" }));
    const flow = await screen.findByRole("dialog", { name: "Fill fermenters" });
    const bases = await within(flow).findByRole("list", { name: "Which mead base?" });
    // Short names: the question already says it is a mead base.
    expect(within(bases).getAllByRole("button").map((b) => b.textContent)).toEqual(["Tasty", "Minor Healing"]);
    fireEvent.click(within(bases).getByRole("button", { name: "Tasty" }));
    expect(within(flow).getByText(/Step 2 of 2/)).toBeInTheDocument();
    expect(within(flow).getByRole("status")).toHaveTextContent("Mead Base: Tasty into empty fermenters near Ragnar");
    // Another place on the last step.
    fireEvent.click(within(flow).getByRole("button", { name: /Freya/ }));
    expect(within(flow).getByRole("status")).toHaveTextContent("near Freya");
    fireEvent.click(within(flow).getByRole("button", { name: "Fill fermenters" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/fill-fermenters")).toBeTruthy());
    expect(await within(flow).findByText("Nothing went in: there are no fermenters there.")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/admin/fill-fermenters")!.body).toEqual({ radius: 50, base: "MeadBaseTasty", player: "Freya" });
  });

  it("walks the smelter flow in Polish", async () => {
    api(status());
    render(<I18nProvider locale="pl"><FillSheet station="smelters" target={{ player: "Ragnar" }} catalog={{ events: [], currentEvent: null, globalKeys: [], spots: [], stations: STATIONS }} onClose={() => {}} /></I18nProvider>);
    const flow = screen.getByRole("dialog", { name: "Napełnij odlewnie" });
    expect(within(flow).getByText(/Krok 1 z 3/)).toBeInTheDocument();
    fireEvent.click(await within(flow).findByRole("button", { name: /Miedź/ }));
    expect(within(flow).getByText("Dosypać węgla?")).toBeInTheDocument();
    fireEvent.click(within(flow).getByRole("button", { name: "Z węglem" }));
    expect(within(flow).getByRole("status")).toHaveTextContent("Odlewnie przy graczu Ragnar: miedź i węgiel");
    fireEvent.click(within(flow).getByRole("button", { name: "Wstecz" }));
    fireEvent.click(within(flow).getByRole("button", { name: "Tylko węgiel" }));
    expect(within(flow).getByRole("status")).toHaveTextContent("Odlewnie przy graczu Ragnar: tylko węgiel");
  });

  it("asks a view-only session to unlock before it lists the ores", async () => {
    const calls = api(status({ required: true, unlocked: false }));
    renderDashboard();
    const panel = await openAdmin();
    fireEvent.click(within(panel).getByRole("button", { name: "Fill fermenters" }));
    const flow = await screen.findByRole("dialog", { name: "Fill fermenters" });
    expect(within(flow).getByText("Unlock admin to see what the stations take.")).toBeInTheDocument();
    expect(within(flow).getByRole("button", { name: "Unlock" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/admin/catalog")).toBe(false);
  });

  it("comes back from a map pick on the summary, with the choices kept", async () => {
    api(status());
    render(<I18nProvider locale="en"><FillSheet station="smelters" target={{ at: { x: 120.4, z: -40 }, label: "map" }} choice={{ pick: "CopperOre", coal: "ore" }} catalog={{ events: [], currentEvent: null, globalKeys: [], spots: [], stations: STATIONS }} onClose={() => {}} /></I18nProvider>);
    const flow = screen.getByRole("dialog", { name: "Fill smelters" });
    expect(within(flow).getByText(/Step 3 of 3/)).toBeInTheDocument();
    expect(within(flow).getByRole("status")).toHaveTextContent("Smelters around x 120, z -40: copper");
  });

  it("gives items found by their Polish name to a player", async () => {
    const calls = api(status());
    renderDashboard();
    const sheet = await openAdmin();
    fireEvent.click(within(sheet).getAllByRole("button", { name: /Ragnar/ })[0]!);
    const player = await screen.findByRole("dialog", { name: "Ragnar" });
    fireEvent.click(within(player).getByRole("button", { name: "Give items" }));
    const picker = await screen.findByRole("dialog", { name: "Give items" });
    fireEvent.change(within(picker).getByRole("searchbox"), { target: { value: "drewno" } });
    fireEvent.click(within(picker).getByRole("button", { name: "Wood" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Amount +" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Give" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/spawn")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/admin/spawn")!.body).toEqual({ item: "Wood", amount: 11, quality: 1, player: "Ragnar" });
  });

  it("asks for the admin password when the panel password is view-only, then retries", async () => {
    const calls = api(status({ required: true, unlocked: false }), (_url, n) =>
      n === 0 ? Response.json({ ok: false, error: "admin_required" }, { status: 403 }) : Response.json({ ok: true, data: { started: true } }),
    );
    renderDashboard();
    const sheet = await openAdmin();
    expect(within(sheet).getByText("View only")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Save the world now" }));
    const unlock = await screen.findByRole("dialog", { name: "Unlock" });
    fireEvent.change(within(unlock).getByLabelText("Admin password"), { target: { value: "jarl" } });
    fireEvent.click(within(unlock).getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/admin/save")).toHaveLength(2));
    expect(calls.find((c) => c.url === "/api/admin/unlock")!.body).toEqual({ password: "jarl" });
  });

  it("says why controls are off and offers to allow an untested build", async () => {
    api(status({}, { tested: false, gameBuild: "l-1.0.18" }));
    renderDashboard();
    const sheet = await openAdmin();
    expect(within(sheet).getByText("Game build l-1.0.18 has not been tested with the bridge.")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /Allow build l-1.0.18/ })).toBeEnabled();
    expect(within(sheet).getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("bans with the same hold as kick, no name to type", async () => {
    api(status());
    renderDashboard();
    const sheet = await openAdmin();
    fireEvent.click(within(sheet).getAllByRole("button", { name: /Freya/ })[0]!);
    const player = await screen.findByRole("dialog", { name: "Freya" });
    expect(within(player).queryByRole("textbox")).not.toBeInTheDocument();
    for (const name of [/Kick Freya/, /Ban Freya/]) {
      const button = within(player).getByRole("button", { name });
      expect(button).toBeEnabled();
      // The hold chip shows on phones too.
      expect(within(button).getByText("Hold")).toBeInTheDocument();
    }
  });

  it("says to hold when a hold button is only tapped, and does nothing else", async () => {
    const calls = api(status());
    renderDashboard();
    const sheet = await openAdmin();
    fireEvent.click(within(sheet).getAllByRole("button", { name: /Freya/ })[0]!);
    const player = await screen.findByRole("dialog", { name: "Freya" });
    const kick = within(player).getByRole("button", { name: /Kick Freya/ });
    fireEvent.pointerDown(kick, { pointerId: 1 });
    fireEvent.pointerUp(kick, { pointerId: 1 });
    fireEvent.pointerLeave(kick, { pointerId: 1 });
    expect(await screen.findAllByText("Press and hold “Kick Freya” to confirm.")).toHaveLength(1);
    expect(calls.find((c) => c.url === "/api/admin/kick")).toBeUndefined();
  });

  it("explains the ban in the access list as a hold, not a tap", async () => {
    api(status());
    renderDashboard();
    const sheet = await openAdmin();
    expect(await within(sheet).findByText(/Make admin \(a tap\) and Ban \(a hold\)/)).toBeInTheDocument();
  });

  it("sets a world key only on a second tap", async () => {
    const calls = api(status());
    renderDashboard();
    const sheet = await openAdmin();
    const nomap = await within(sheet).findByRole("switch", { name: "No map" });
    await waitFor(() => expect(nomap).toBeEnabled());
    fireEvent.click(nomap);
    expect(within(sheet).getByText("This changes the game for everyone at once. Tap again to confirm.")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/admin/globalkey-set")).toBeUndefined();
    fireEvent.click(nomap);
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/globalkey-set")?.body).toEqual({ key: "nomap" }));
  });

  it("starts a raid only on a second tap", async () => {
    const calls = api(status());
    renderDashboard();
    const sheet = await openAdmin();
    fireEvent.click(await within(sheet).findByRole("button", { name: "You are being hunted..." }));
    const start = within(sheet).getByRole("button", { name: /^Start / });
    fireEvent.click(start);
    expect(calls.find((c) => c.url === "/api/admin/event-start")).toBeUndefined();
    expect(within(sheet).getByRole("button", { name: /^Really start / })).toBe(start);
    fireEvent.click(start);
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/event-start")?.body).toMatchObject({ name: "wolves" }));
  });

  it("answers everyone who asked for the one unlock prompt", async () => {
    api(status({ required: true, unlocked: false }));
    let admin: Admin | null = null;
    const Grab = () => {
      admin = useAdmin();
      return null;
    };
    render(
      <AdminProvider state={fixture()} online onUnauthorized={() => {}} onShowMap={() => {}}>
        <Grab />
      </AdminProvider>,
    );
    let first: Promise<boolean>, second: Promise<boolean>;
    act(() => {
      first = admin!.unlock();
      second = admin!.unlock();
    });
    const unlock = await screen.findByRole("dialog", { name: "Unlock" });
    fireEvent.change(within(unlock).getByLabelText("Admin password"), { target: { value: "jarl" } });
    fireEvent.click(within(unlock).getByRole("button", { name: "Unlock" }));
    await expect(Promise.all([first!, second!])).resolves.toEqual([true, true]);
  });

  it("holds a ban longer than a kick, so a kick hold cannot ban", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls = api(status());
      renderDashboard();
      const sheet = await openAdmin();
      fireEvent.click(within(sheet).getAllByRole("button", { name: /Freya/ })[0]!);
      const player = await screen.findByRole("dialog", { name: "Freya" });
      const ban = within(player).getByRole("button", { name: /Ban Freya/ });
      fireEvent.pointerDown(ban, { pointerId: 1 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      fireEvent.pointerUp(ban, { pointerId: 1 });
      expect(calls.find((c) => c.url === "/api/admin/ban")).toBeUndefined();
      fireEvent.pointerDown(ban, { pointerId: 1 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2300);
      });
      await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/ban")?.body).toEqual({ player: "Freya" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks a view-only session to unlock when a rune is held, then runs it", async () => {
    let actions = 0;
    const calls = api(status({ required: true, unlocked: false }));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === "/api/action/restart") {
        calls.push({ url: String(url), method: "POST", body: undefined, headers: {} });
        return actions++ === 0 ? Response.json({ ok: false, error: "admin_required", message: "admin session required" }, { status: 403 }) : Response.json({ ok: true, message: "" });
      }
      return inner(url, init);
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderDashboard();
      const rune = await screen.findByRole("button", { name: /Restart server\. Hold/ });
      fireEvent.pointerDown(rune, { pointerId: 1 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1700);
      });
      const unlock = await screen.findByRole("dialog", { name: "Unlock" });
      expect(screen.queryByText("admin session required")).not.toBeInTheDocument();
      fireEvent.change(within(unlock).getByLabelText("Admin password"), { target: { value: "jarl" } });
      fireEvent.click(within(unlock).getByRole("button", { name: "Unlock" }));
      await waitFor(() => expect(calls.filter((c) => c.url === "/api/action/restart")).toHaveLength(2));
      expect(await screen.findAllByText("Accepted")).not.toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("restore", () => {
  const backup = RESTORE.backups[1]!;
  const sheet = (players: boolean) => {
    const state = fixture();
    if (!players) state.players = [];
    return render(
      <I18nProvider locale="en">
        <AdminProvider state={state} online onUnauthorized={() => {}} onShowMap={() => {}}>
          <RestoreSheet backup={backup} onClose={() => {}} />
        </AdminProvider>
      </I18nProvider>,
    );
  };

  it("holds the restore until the world name is typed exactly", () => {
    api(status());
    sheet(false);
    const go = screen.getByRole("button", { name: /Restore .*2026/ });
    const input = screen.getByLabelText("To confirm, type the world name: Midgard");
    expect(go).toBeDisabled();
    fireEvent.change(input, { target: { value: "midgard" } });
    expect(go).toBeDisabled();
    fireEvent.change(input, { target: { value: "Midgard" } });
    expect(go).toBeEnabled();
  });

  it("refuses while players are online", () => {
    api(status());
    sheet(true);
    fireEvent.change(screen.getByLabelText("To confirm, type the world name: Midgard"), { target: { value: "Midgard" } });
    expect(screen.getByRole("button", { name: /Restore .*2026/ })).toBeDisabled();
    expect(screen.getByText("Players are online. A restore only runs on an empty server.")).toBeInTheDocument();
  });

  const ev = (seq: number, step: string, result = "ok", extra: Record<string, unknown> = {}): AgentEvent => ({ seq, ts: "2026-10-09T20:00:00Z", type: "admin", data: { command: "restore", step, result, ...extra } });

  it("follows a run from its events", () => {
    const ok = [ev(11, "begin"), ev(12, "safety"), ev(13, "stop"), ev(14, "extract"), ev(15, "start"), ev(16, "done")];
    // An older run before the request and newest-first order do not confuse it.
    const p = restoreProgress([...ok].reverse().concat(ev(3, "done")), 10);
    expect(p).toMatchObject({ started: true, done: true, finished: true, error: null, rolledBack: false });
    expect(restoreProgress(ok.slice(0, 3), 10)).toMatchObject({ finished: false });
    const rolled = restoreProgress([ev(11, "begin"), ev(12, "safety"), ev(13, "stop"), ev(14, "extract", "error", { error: "disk full" }), ev(15, "rollback")], 10);
    expect(rolled).toMatchObject({ error: "disk full", rolledBack: true, finished: false });
    expect(restoreProgress([ev(11, "begin"), ev(12, "safety"), ev(13, "stop"), ev(14, "extract", "error", { error: "x" }), ev(15, "rollback"), ev(16, "start")], 10).finished).toBe(true);
    expect(restoreProgress([ev(11, "begin"), ev(12, "safety", "error", { error: "no space" })], 10)).toMatchObject({ finished: true, rolledBack: false });
    expect(restoreProgress([ev(11, "begin"), ev(12, "safety"), ev(13, "stop"), ev(14, "start", "error"), ev(15, "rollback", "error")], 10).finished).toBe(true);
  });
});

describe("admin lines in the saga", () => {
  const i = makeI18n("en");
  it("audits list changes by name or a masked id, and every restore step", () => {
    expect(describeAdmin(i, { actor: "Sigrun", command: "admin-add", result: "ok", via: "file", platform: "xbox", player: "Ragnar" })).toBe("Sigrun made Ragnar an admin (from the next restart)");
    const anon = describeAdmin(i, { actor: "Sigrun", command: "ban", result: "ok", via: "file", platform: "steam", masked: "V_***0009" });
    expect(anon).toBe("Sigrun banned an unknown player (PC (Steam), V_***0009) (from the next restart)");
    expect(describeAdmin(i, { actor: "Sigrun", command: "restore", step: "done", result: "ok", backup: "worlds-20261009-180000.zip", archive: "pre-restore-20261009-190000.zip" })).toBe(
      "Sigrun restored the world from worlds-20261009-180000.zip. The previous world is kept as pre-restore-20261009-190000.zip",
    );
    expect(describeAdmin(i, { actor: "k", command: "restore", step: "extract", result: "error", error: "disk full" })).toBe("Restore: putting the backup in place failed (disk full)");
    expect(describeAdmin(i, { actor: "k", command: "restore", step: "rollback", result: "ok" })).toBe("Restore undone: the previous world is back");
    expect(describeAdmin(makeI18n("pl"), { actor: "k", command: "admin-remove", result: "ok", via: "file", player: "Freya" })).toBe("k odebrał admina: Freya (od najbliższego restartu)");
  });
});

describe("admin lines in the saga", () => {
  const en = makeI18n("en");
  const pl = makeI18n("pl");
  it("tells who did what for whom, never an id", () => {
    expect(describeAdmin(en, { actor: "Sigrun", command: "spawn", result: "ok", item: "Wood", amount: 20, player: "Ragnar" })).toBe("Sigrun spawned 20 Wood for Ragnar");
    expect(describeAdmin(en, { actor: "dashboard-1a2b3c", command: "spawn", result: "ok", items: [{ item: "Wood", amount: 20 }, { item: "SwordIron", amount: 1, quality: 3 }] })).toBe("An admin spawned 20 Wood, Iron Sword ★★★");
    expect(describeAdmin(en, { actor: "k", command: "kick", result: "ok", player: "Freya" })).toBe("k kicked Freya");
    expect(describeAdmin(en, { actor: "k", command: "time", result: "ok", dayFraction: 0.25 })).toBe("k set the time to 06:00");
    expect(describeAdmin(en, { actor: "k", command: "ban", result: "error", error: "no connected player 'Ragnar'" })).toBe("k: a ban failed (Ragnar is not in the game any more)");
    expect(describeAdmin(en, { actor: "k", command: "ban", result: "error", error: "something new" })).toBe("k: a ban failed (something new)");
    expect(describeAdmin(pl, { actor: "Sigrun", command: "spawn", result: "ok", item: "Wood", amount: 20, player: "Ragnar" })).toBe("Sigrun przywołał 20 Drewno dla: Ragnar");
    expect(describeAdmin(pl, { actor: "k", command: "event-start", result: "ok", name: "wolves" })).toMatch(/^k sprowadził najazd: /);
  });

  it("says what a fill put in", () => {
    const smelters = { actor: "k", command: "fill-smelters", result: "ok", what: "both", ore: "IronScrap", smelters: 3, skipped: 1, added: { IronScrap: 3 }, fuel: "Coal", player: "Ragnar" };
    expect(describeAdmin(en, smelters)).toBe("k filled 3 smelters with scrap iron and coal near Ragnar");
    expect(describeAdmin(pl, smelters)).toBe("k napełnił odlewnie (3, złom żelaza i węgiel) obok: Ragnar");
    // Keep the current ore: whatever each one held.
    const current = { actor: "k", command: "fill-smelters", result: "ok", smelters: 2, added: { CopperOre: 1, TinOre: 1 } };
    expect(describeAdmin(en, current)).toBe("k filled 2 smelters with copper and tin");
    expect(describeAdmin(pl, current)).toBe("k napełnił odlewnie (2, miedź i cyna)");
    expect(describeAdmin(en, { actor: "k", command: "fill-smelters", result: "ok", smelters: 2, added: {}, fuel: "Coal" })).toBe("k filled 2 smelters with coal");
    // An ore the game names but the panel does not still reads as words.
    expect(describeAdmin(en, { actor: "k", command: "fill-smelters", result: "ok", smelters: 1, added: { MysteryOre: 1 } })).toBe("k filled 1 smelter with mystery ore");
    expect(describeAdmin(en, { actor: "k", command: "fill-smelters", result: "ok", smelters: 0, skipped: 2, added: {}, player: "Freya" })).toBe("k added nothing to the smelters near Freya: they are full or do not take that ore");
    expect(describeAdmin(en, { actor: "k", command: "fill-smelters", result: "ok", smelters: 0, skipped: 0, full: 0, added: {}, player: "Freya" })).toBe("k found no smelters to fill near Freya");
    expect(describeAdmin(pl, { actor: "k", command: "fill-kilns", result: "ok", kilns: 0, full: 2, added: {} })).toBe("k nie dosypał nic do mielerzy (są już pełne)");
    const kilns = { actor: "k", command: "fill-kilns", result: "ok", kilns: 2, added: { Wood: 2 }, player: "Ragnar" };
    expect(describeAdmin(en, kilns)).toBe("k filled 2 kilns with wood near Ragnar");
    expect(describeAdmin(pl, kilns)).toBe("k napełnił mielerze (2, drewno) obok: Ragnar");
    expect(describeAdmin(pl, { actor: "k", command: "fill-kilns", result: "ok", kilns: 0, added: {} })).toBe("k nie znalazł mielerzy do napełnienia");
    expect(describeAdmin(en, { actor: "k", command: "fill-kilns", result: "timeout" })).toBe("k: filling kilns took too long");
    // Lines stored before the split still read as before.
    expect(describeAdmin(en, { actor: "k", command: "fill", result: "ok", smelters: 2, fermenters: 1 })).toBe("k filled 3 kilns and smelters");
    const mead = { actor: "k", command: "fill-fermenters", result: "ok", base: "MeadBaseTasty", fermenters: 2, full: 1, added: { MeadBaseTasty: 2 }, player: "Freya" };
    expect(describeAdmin(en, mead)).toBe("k started 2 fermenters with Mead Base: Tasty near Freya");
    expect(describeAdmin(pl, mead)).toBe("k napełnił fermentatory (2, Brzeczka miodowa: Pyszna) obok: Freya");
    expect(describeAdmin(en, { actor: "k", command: "fill-fermenters", result: "ok", fermenters: 0, full: 3, added: {} })).toBe("k added nothing to the fermenters: they are busy or do not take that base");
    expect(describeAdmin(pl, { actor: "k", command: "fill-fermenters", result: "ok", fermenters: 0, added: {}, player: "Freya" })).toBe("k nie znalazł fermentatorów do napełnienia obok: Freya");
  });
});

describe("live markers", () => {
  it("glide between samples and jump across portals", () => {
    const g = new Glide();
    const p = (x: number, z = 0) => [{ name: "Ragnar", platform: "xbox" as const, x, z, health: 1, maxHealth: 1 }];
    g.step(p(0), 0.016, false);
    expect(g.at("Ragnar")).toMatchObject({ x: 0, z: 0 });
    let moving = g.step(p(10), 0.1, false);
    expect(moving).toBe(true);
    const x = g.at("Ragnar")!.x;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(10);
    for (let i = 0; i < 200; i++) moving = g.step(p(10), 0.05, false);
    expect(moving).toBe(false);
    expect(g.at("Ragnar")!.x).toBeCloseTo(10, 1);
    g.step(p(2000), 0.016, false);
    expect(g.at("Ragnar")!.x).toBe(2000);
    g.step([], 0.016, false);
    expect(g.at("Ragnar")).toBeNull();
  });
});

describe("in Polish", () => {
  it("names the admin sheet", async () => {
    api(status());
    render(
      <I18nProvider locale="pl">
        <Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={async () => "ok" as const} />
      </I18nProvider>,
    );
    const sheet = await openAdmin();
    expect(within(sheet).getByText("Komunikat")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Przewiń do rana" })).toBeInTheDocument();
  });
});
