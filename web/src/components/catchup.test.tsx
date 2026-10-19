import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { seenOf } from "../lib/catchup";
import type { ApiCatchup } from "../types";
import { Catchup, type CatchupLinks } from "./Catchup";
import { ProfileProvider } from "./PlayerName";
import { PHONE } from "../lib/useMedia";

const NOW = Date.parse("2026-10-09T18:00:00Z");

const answer = (over: Partial<ApiCatchup> = {}): ApiCatchup => ({
  since: new Date(NOW - 7 * 86_400_000).toISOString(),
  until: new Date(NOW).toISOString(),
  clamped: true,
  partial: false,
  players: [],
  raids: 0,
  backups: 0,
  restores: 0,
  restarts: 0,
  updates: [],
  settings: 0,
  bosses: ["defeated_eikthyr"],
  world: { id: "w1", netTime: 5000, portals: [], bases: [{ x: 0, z: 0 }], ships: 1, carts: 0, places: [], exploredM2: 2_000_000 },
  ...over,
});

let replies: ApiCatchup[];
let fetchMock: ReturnType<typeof vi.fn>;
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

function show(locale: "en" | "pl" = "en") {
  const links: CatchupLinks = { onMap: vi.fn(), onSaga: vi.fn(), onProgress: vi.fn() };
  const openProfile = vi.fn();
  render(
    <I18nProvider locale={locale}>
      <ProfileProvider value={openProfile}>
        <Catchup pulse="a" links={links} />
      </ProfileProvider>
    </I18nProvider>,
  );
  return { links, openProfile };
}

describe("Catchup", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    localStorage.clear();
    replies = [];
    fetchMock = vi.fn(async () => new Response(JSON.stringify(replies.shift() ?? answer()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("covers the last week on a first visit, and folds once read", async () => {
    replies.push(
      answer({ players: [{ name: "Ragnar", playtimeMs: 2 * 3_600_000 + 600_000, sessions: 2, deaths: 3, online: false }], raids: 1, backups: 1 }),
      answer({ since: new Date(NOW).toISOString(), clamped: false }),
    );
    const { links, openProfile } = show();
    expect(await screen.findByRole("heading", { name: "Since you were last here" })).toBeInTheDocument();
    expect(urls()[0]).toBe("/api/catchup");
    expect(screen.getByText("last 7 days")).toBeInTheDocument();
    expect(screen.getByText("Ragnar", { selector: "button" }).parentElement).toHaveTextContent("Ragnar played 2 h 10 min · 3 deaths");
    fireEvent.click(screen.getByText("Ragnar", { selector: "button" }));
    expect(openProfile).toHaveBeenCalledWith("Ragnar", expect.any(HTMLElement));
    fireEvent.click(screen.getByRole("button", { name: /A raid/ }));
    expect(links.onSaga).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /A world backup was made/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(await screen.findByText(/^Nothing new since/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Since you were last here" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("skald.catchup")!).at).toBe(new Date(NOW).toISOString());
    await vi.waitFor(() => expect(urls()[1]).toBe(`/api/catchup?since=${encodeURIComponent(new Date(NOW).toISOString())}`));
  });

  it("tells a returning player what changed in the world, each line leading to it", async () => {
    const before = answer({ clamped: false });
    localStorage.setItem("skald.catchup", JSON.stringify({ ...seenOf(before), at: new Date(NOW - 26 * 3_600_000).toISOString() }));
    replies.push(
      answer({
        since: new Date(NOW - 26 * 3_600_000).toISOString(),
        clamped: false,
        bosses: ["defeated_eikthyr", "defeated_gdking"],
        world: { ...before.world!, bases: [...before.world!.bases, { x: 900, z: 900 }], ships: 0, places: [{ kind: "trader", name: "Vendor_BlackForest", x: -900, z: 400 }] },
      }),
    );
    const { links } = show();
    expect(await screen.findByText("since yesterday")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "The Elder has fallen" }));
    expect(links.onProgress).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Found: / }));
    expect(links.onMap).toHaveBeenLastCalledWith({ kind: "trader", name: "Vendor_BlackForest", x: -900, z: 400 });
    fireEvent.click(screen.getByRole("button", { name: "A new base" }));
    expect(links.onMap).toHaveBeenLastCalledWith({ x: 900, z: 900 });
    expect(screen.getByRole("button", { name: "A ship is gone" })).toBeInTheDocument();
  });

  it("keeps a long list short until asked", async () => {
    const names = ["Ragnar", "Freya", "Bjorn", "Astrid"];
    replies.push(answer({ players: names.map((name) => ({ name, playtimeMs: 3_600_000, sessions: 1, deaths: 0, online: false })), raids: 2, restarts: 1, backups: 1, settings: 2 }));
    show();
    await screen.findByRole("heading", { name: "Since you were last here" });
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Server settings changed 2 times" })).toBeInTheDocument();
  });

  it("shows three lines on a phone, and playtime with its own mark", async () => {
    (window as unknown as { __media?: Record<string, boolean> }).__media = { [PHONE]: true };
    try {
      replies.push(answer({ players: [{ name: "Ragnar", playtimeMs: 3_600_000, sessions: 1, deaths: 2, online: false }], raids: 2, restarts: 1, backups: 1, settings: 2 }));
      show();
      await screen.findByRole("heading", { name: "Since you were last here" });
      expect(screen.getAllByRole("listitem")).toHaveLength(3);
      expect(screen.getByRole("button", { name: "Show 2 more" })).toBeInTheDocument();
      // Deaths are a count in the text; the mark is for playing.
      const row = screen.getByText("Ragnar", { selector: "button" }).closest("li")!;
      expect(row.querySelector("[data-mark]")).toHaveAttribute("data-mark", "play");
    } finally {
      (window as unknown as { __media?: Record<string, boolean> }).__media = {};
    }
  });

  it("keeps the world it knew when read while the map is away", async () => {
    const before = answer({ clamped: false });
    localStorage.setItem("skald.catchup", JSON.stringify({ ...seenOf(before), at: new Date(NOW - 3_600_000).toISOString() }));
    replies.push(answer({ since: new Date(NOW - 3_600_000).toISOString(), clamped: false, world: null, bosses: null, raids: 1 }));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Got it" }));
    const kept = JSON.parse(localStorage.getItem("skald.catchup")!);
    expect(kept.world).toEqual(seenOf(before).world);
    expect(kept.bosses).toEqual(before.bosses);
  });

  it("asks again while the server's window is cut short", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    replies.push(answer({ partial: true }), answer());
    show();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve(fetchMock.mock.results[0]!.value);
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("keeps asking while cut short, also after a failed try", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    let n = 0;
    fetchMock.mockImplementation(async () => (++n === 2 ? new Response("{}", { status: 502 }) : Response.json(answer({ partial: true }))));
    show();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    for (const calls of [2, 3]) {
      // Let the last answer (or failure) land before the clock moves.
      await act(async () => {
        await fetchMock.mock.results.at(-1)!.value;
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
    }
  });

  it("says nothing is new in one quiet line, in Polish too", async () => {
    localStorage.setItem("skald.catchup", JSON.stringify({ ...seenOf(answer()), at: new Date(NOW - 26 * 3_600_000).toISOString() }));
    replies.push(answer({ since: new Date(NOW - 26 * 3_600_000).toISOString(), clamped: false }));
    show("pl");
    expect(await screen.findByText("Nic nowego od wczoraj")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it.each([
    ["an error", () => new Response("{}", { status: 502 })],
    ["an answer that is not a summary", () => Response.json({ current: {} })],
    ["a summary with a broken world", () => Response.json({ ...answer(), world: { portals: "x" } })],
    ["a summary with broken bosses", () => Response.json({ ...answer(), bosses: "all" })],
    ["a summary with a world clock missing", () => Response.json({ ...answer(), world: { ...answer().world, netTime: undefined } })],
    ["a summary with a broken base", () => Response.json({ ...answer(), world: { ...answer().world, bases: [null] } })],
    ["a summary with a broken place", () => Response.json({ ...answer(), world: { ...answer().world, places: [{}] } })],
    ["a summary with a broken player", () => Response.json({ ...answer(), players: [null] })],
  ])("shows nothing on %s", async (_, reply) => {
    fetchMock.mockImplementation(async () => reply());
    const { container } = render(
      <I18nProvider locale="en">
        <Catchup pulse="a" links={{ onMap: vi.fn(), onSaga: vi.fn(), onProgress: vi.fn() }} />
      </I18nProvider>,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Let the answer land: a good one would render by now.
    await act(async () => {
      await Promise.resolve(fetchMock.mock.results[0]!.value);
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(container).toBeEmptyDOMElement();
  });
});
