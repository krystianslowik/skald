import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAdminLinks } from "../../lib/adminlinks";
import { I18nProvider, makeI18n } from "../../i18n";
import { linkVerdict } from "../../lib/link";
import type { PlayerLink } from "../../lib/adminlinks";
import { LinkDetail, LinkLine, linkText, simText } from "./LinkInfo";

const plain = (s: string | null) => s?.replace(/[  ]/g, " ") ?? null;

// As the mock agent reports a player on a bad line who runs the base.
const BAD: PlayerLink = {
  link: { transport: "crossplay", pingMs: 240, pingMaxMs: 620, replyGapMaxS: 3.4, queueBytes: 11264, outBps: 2600, inBps: 1500 },
  sim: { owned: 1240, nearby: 1500, zones: 7 },
};

describe("link verdict", () => {
  it("takes the worst of ping, stalls and backlog", () => {
    expect(linkVerdict({ transport: "crossplay", pingMs: 60, replyGapMaxS: 1, queueBytes: 0 })).toBe("good");
    expect(linkVerdict({ transport: "crossplay", pingMs: 120 })).toBe("fair");
    expect(linkVerdict({ transport: "crossplay", pingMs: 250 })).toBe("poor");
    // A fast ping does not hide a stall or a backlog the game throttles on.
    expect(linkVerdict({ transport: "crossplay", pingMs: 40, replyGapMaxS: 2.5 })).toBe("poor");
    expect(linkVerdict({ transport: "crossplay", pingMs: 40, replyGapMaxS: 1.6 })).toBe("fair");
    // The game holds back world updates strictly above 8 KiB of backlog.
    expect(linkVerdict({ transport: "crossplay", pingMs: 40, queueBytes: 8448 })).toBe("poor");
    expect(linkVerdict({ transport: "crossplay", pingMs: 40, queueBytes: 8192 })).toBe("fair");
    expect(linkVerdict({ transport: "crossplay", pingMs: 40, queueBytes: 4352 })).toBe("fair");
    expect(linkVerdict({ transport: "crossplay", pingMs: 40, queueBytes: 4096 })).toBe("good");
    // Without a ping: judged by what is known.
    expect(linkVerdict({ transport: "crossplay", replyGapMaxS: 1.1 })).toBe("good");
  });

  it("is unknown when the bridge measured nothing", () => {
    expect(linkVerdict(undefined)).toBeNull();
    expect(linkVerdict({ transport: "crossplay", outBps: 100 })).toBeNull();
  });
});

describe("link wording", () => {
  it("reads plainly in both languages", () => {
    const en = makeI18n("en");
    const pl = makeI18n("pl");
    expect(linkText(en, BAD)).toBe("Link: poor (ping 240 ms)");
    expect(linkText(pl, BAD)).toBe("Łącze: słabe (ping 240 ms)");
    expect(plain(simText(en, BAD))).toBe("Simulates the area: 1,240 objects");
    // Polish groups digits from five on (CLDR): 1240, but 12 400.
    expect(plain(simText(pl, BAD))).toBe("Liczy okolicę: 1240 obiektów");
    expect(plain(simText(pl, { sim: { owned: 12400, nearby: 13000, zones: 9 } }))).toBe("Liczy okolicę: 12 400 obiektów");
    expect(simText(pl, { sim: { owned: 1, nearby: 3, zones: 1 } })).toBe("Liczy okolicę: 1 obiekt");
    expect(simText(pl, { sim: { owned: 3, nearby: 3, zones: 1 } })).toBe("Liczy okolicę: 3 obiekty");
    expect(linkText(en, { link: { transport: "crossplay", replyGapMaxS: 1 } })).toBe("Link: good");
    expect(linkText(en, {})).toBeNull();
    expect(simText(en, {})).toBeNull();
  });

  it("shows a row line only when the bridge reports something", () => {
    const { container } = render(
      <I18nProvider locale="en">
        <LinkLine p={{}} />
        <LinkLine p={undefined} />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
    render(
      <I18nProvider locale="en">
        <LinkLine p={BAD} />
      </I18nProvider>,
    );
    expect(screen.getByText("Link: poor (ping 240 ms)")).toHaveClass("text-blood");
  });

  it("explains the verdict and what the player simulates in the player sheet", () => {
    render(
      <I18nProvider locale="pl">
        <LinkDetail p={BAD} />
      </I18nProvider>,
    );
    const section = screen.getByRole("region", { name: "Łącze i okolica" });
    expect(section).toHaveTextContent("Łącze: słabe (ping 240 ms)");
    expect(plain(section.textContent)).toContain("najgorzej 620 ms · przestoje do 3,4 s · 11 KB czeka, więc serwer wstrzymuje mu zmiany w świecie");
    expect(plain(section.textContent)).toContain("Liczy okolicę: 1240 obiektów");
    expect(plain(section.textContent)).toContain("z 1500 w pobliżu, w 7 strefach");
    expect(section).toHaveTextContent("Kto pierwszy wczyta okolicę, ten ją liczy dla wszystkich obok");
  });

  it("says when another player simulates the area, and when crossplay gives no ping", () => {
    render(
      <I18nProvider locale="en">
        <LinkDetail p={{ link: { transport: "crossplay", replyGapMaxS: 1 }, sim: { owned: 0, nearby: 900, zones: 0 } }} />
      </I18nProvider>,
    );
    const section = screen.getByRole("region", { name: "Connection and area" });
    expect(section).toHaveTextContent("Link: good");
    expect(section).toHaveTextContent("crossplay gives no ping yet");
    expect(section).toHaveTextContent("Simulates the area: 0 objects");
    expect(section).toHaveTextContent("Another player near them simulates it.");
  });
});

describe("a ping the plugin is unsure of", () => {
  it("judges by the stall and says why there is no ping", () => {
    const p: PlayerLink = { link: { transport: "crossplay", pingUnsure: true, replyGapMaxS: 3.1, queueBytes: 0 }, sim: { owned: 10, nearby: 20, zones: 1 } };
    expect(linkText(makeI18n("en"), p)).toBe("Link: poor");
    render(
      <I18nProvider locale="en">
        <LinkDetail p={p} />
      </I18nProvider>,
    );
    const section = screen.getByRole("region", { name: "Connection and area" });
    expect(section).toHaveTextContent("stalls of up to 3.1 s · ping unknown for a moment after a stall");
    expect(section).not.toHaveTextContent("crossplay gives no ping");
  });
});

describe("admin-only link polling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function Probe({ on }: { on: boolean }) {
    const links = useAdminLinks(on);
    return <p>{linkText(makeI18n("en"), links.get("Freya") ?? {}) ?? "none"}</p>;
  }

  it("fetches the admin player list only for an admin, and refreshes it while shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return Response.json({ ok: true, data: { players: [{ id: "Freya", name: "Freya", platform: "steam", x: 0, y: 0, z: 0, health: 1, maxHealth: 1, hasCharacter: true, ...BAD }] } });
      }),
    );
    const { rerender, unmount } = render(<Probe on={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(calls).toEqual([]);
    expect(screen.getByText("none")).toBeInTheDocument();
    rerender(<Probe on />);
    await waitFor(() => expect(screen.getByText("Link: poor (ping 240 ms)")).toBeInTheDocument());
    expect(calls).toEqual(["/api/admin/players"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(calls.length).toBe(2);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11000);
    });
    expect(calls.length).toBe(2);
  });
});
