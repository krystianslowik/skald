import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { HttpAgent } from "../src/agent";
import { applyEvent } from "../src/apply";
import { MockAgent } from "../src/mock";
import { mockCompat } from "../src/mockcompat";
import { DiscordNotifier, formatBatch, NOTIFY_KINDS, type NotifyKind } from "../src/notify";
import { emptyAgentState, UNSTORED_EVENTS, type AgentEvent, type CompatResult, type LiveMessage } from "../src/types";

const T0 = Date.parse("2026-10-18T18:00:00Z");
const ev = (seq: number, data: Record<string, unknown>, at = T0 + seq * 1000): AgentEvent => ({ seq, ts: new Date(at).toISOString(), type: "compat", data });

const failed = (trigger: CompatResult["trigger"] = "update") => mockCompat("fail", "l-1.0.20", 41, T0, trigger).result!;

describe("compat in the live state", () => {
  it("follows the agent's events: running with the last result, then the new one", () => {
    let s = emptyAgentState();
    expect(s.compat).toBeNull();
    const r = failed();
    s = applyEvent(s, ev(1, { running: true, result: null }));
    expect(s.compat).toEqual({ running: true, result: null });
    s = applyEvent(s, ev(2, { running: false, result: r }));
    expect(s.compat).toEqual({ running: false, result: r });
    // A run that keeps the last result while it waits.
    s = applyEvent(s, ev(3, { running: true }));
    expect(s.compat).toEqual({ running: true, result: r });
    expect(UNSTORED_EVENTS).toContain("compat");
  });
});

describe("compat notifications", () => {
  const discord = () => {
    const sent: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string).content);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    return { sent, fetchImpl };
  };
  const notifier = (fetchImpl: typeof fetch, kinds: readonly NotifyKind[] = NOTIFY_KINDS) => {
    const n = new DiscordNotifier({ url: "https://discord.example/api/webhooks/1/t", kinds, locale: "en", fetchImpl, clock: () => T0, coalesceMs: 10 });
    const s = emptyAgentState();
    s.server.version = "l-1.0.20";
    n.handle({ type: "state", state: s, online: true });
    return n;
  };
  const live = (e: AgentEvent): LiveMessage => ({ type: "event", event: e });

  it("sums up a new build's check with what failed", async () => {
    const d = discord();
    const n = notifier(d.fetchImpl);
    n.handle(live(ev(1, { running: true, result: null })));
    n.handle(live(ev(2, { running: false, result: failed() })));
    await Bun.sleep(30);
    await n.idle();
    n.stop();
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]!.split("\n")).toEqual([
      "Skald checked the game update from 1.0.16 to 1.0.20: something broke",
      "- Save: 41 containers unreadable (the game saves inventories in a new format (version 111) that Skald does not know yet)",
      "- Admin plugin: not tested on this build yet, commands wait for a confirmation",
      "Details in the admin sheet.",
    ]);
  });

  it("says when all is fine, and nothing for a start, a manual run or a clean first save", async () => {
    const d = discord();
    const n = notifier(d.fetchImpl);
    const ok = mockCompat("ok", "l-1.0.20", 41, T0).result!;
    n.handle(live(ev(1, { running: false, result: ok })));
    n.handle(live(ev(2, { running: false, result: { ...ok, trigger: "start" } })));
    n.handle(live(ev(3, { running: false, result: { ...ok, trigger: "manual" } })));
    n.handle(live(ev(4, { running: false, result: { ...ok, trigger: "save" } })));
    n.handle(live(ev(5, { running: false, result: { ...ok, updated: false, previousBuild: undefined } })));
    await Bun.sleep(30);
    await n.idle();
    n.stop();
    expect(d.sent).toEqual(["Skald checked the game update from 1.0.16 to 1.0.20: all fine"]);
  });

  it("reports a first save that found a problem, and a save check still to come", async () => {
    const d = discord();
    const n = notifier(d.fetchImpl);
    const pending = mockCompat("pending", "l-1.0.20", 41, T0).result!;
    n.handle(live(ev(1, { running: false, result: pending })));
    n.handle(live(ev(2, { running: false, result: failed("save") })));
    await Bun.sleep(30);
    await n.idle();
    n.stop();
    // Both at once here; in a real update half an hour apart.
    const lines = d.sent.join("\n").split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "Skald checked the game update from 1.0.16 to 1.0.20: all fine",
      "The save is checked again after the first save on the new build.",
      "Skald checked the first save on 1.0.20: something broke",
    ]);
  });

  it("goes out only with the compat kind chosen", async () => {
    const d = discord();
    const n = notifier(d.fetchImpl, NOTIFY_KINDS.filter((k) => k !== "compat"));
    n.handle(live(ev(1, { running: false, result: failed() })));
    await Bun.sleep(30);
    await n.idle();
    n.stop();
    expect(d.sent).toHaveLength(0);
  });

  it("counts the unreadable chunks for a chunk failure", () => {
    const r = failed();
    r.checks[1] = { name: "save", status: "fail", reason: "chunks_unreadable", detail: { chunksUnreadable: 37, containersUnreadable: 0 } };
    expect(formatBatch([{ kind: "compat", result: r, followUp: false }], "en")[1]).toBe("- Save: 37 parts of the world unreadable");
  });

  it("is in Polish too, with player-proof markdown", () => {
    const r = { ...failed(), build: "l-1.0.20*", previousBuild: "l-1.0.16_" };
    const lines = formatBatch([{ kind: "compat", result: r, followUp: false }], "pl");
    expect(lines[0]).toBe("Skald sprawdził aktualizację gry z 1.0.16\\_ do 1.0.20\\*: coś przestało działać");
    expect(lines[1]).toBe("- Zapis świata: nieczytelne skrzynie: 41 (gra zapisuje ekwipunek w nowym formacie (wersja 111), którego Skald jeszcze nie zna)");
  });

  it("words the reason containers did not read from its code, else shows the agent's text (#152)", () => {
    const r = failed();
    const save = (detail: Record<string, unknown>) => {
      r.checks[1] = { name: "save", status: "fail", reason: "containers_unreadable", detail: { containersUnreadable: 2, ...detail } };
      return formatBatch([{ kind: "compat", result: r, followUp: false }], "en")[1];
    };
    expect(save({ containerReason: "reworded", containerReasonCode: "inventory_flags", containerReasonValue: 128 })).toBe("- Save: 2 containers unreadable (an item has unknown flags (0x80))");
    expect(save({ containerReason: "a *new* shape", containerReasonCode: "other", containerReasonValue: 0 })).toBe("- Save: 2 containers unreadable (a \\*new\\* shape)");
    // An agent from before the codes.
    expect(save({ containerReason: "unreadable inventory: version 111" })).toBe("- Save: 2 containers unreadable (unreadable inventory: version 111)");
  });

  it("has words in both languages for every reason code the agent sends", () => {
    const src = readFileSync(`${import.meta.dir}/../../agent/internal/worldmap/inventory.go`, "utf8");
    const codes = [...src.matchAll(/^\s*Reason\w+\s*=\s*"(\w+)"/gm)].map((m) => m[1]!);
    expect(codes).toContain("inventory_version");
    const r = failed();
    for (const locale of ["en", "pl"] as const) {
      for (const code of codes.filter((c) => c !== "other")) {
        r.checks[1] = { name: "save", status: "fail", reason: "containers_unreadable", detail: { containersUnreadable: 1, containerReason: "raw", containerReasonCode: code, containerReasonValue: 7 } };
        expect(formatBatch([{ kind: "compat", result: r, followUp: false }], locale)[1]).not.toContain("(raw)");
      }
    }
  });
});

describe("compat in the mock", () => {
  it("serves the chosen outcome and runs again from the panel", async () => {
    let now = T0;
    const m = new MockAgent(() => now, "UTC", "on", "fail");
    const st = await m.getState();
    expect(st.compat?.result?.status).toBe("fail");
    expect(st.compat?.result?.checks.map((c) => c.name)).toEqual(["version", "save", "terrain", "bridge", "logs"]);
    const seen: AgentEvent[] = [];
    const ac = new AbortController();
    const streaming = m.stream(Number.MAX_SAFE_INTEGER, (e) => seen.push(e), ac.signal);
    expect((await m.tools({ op: "compat-run", actor: "Ragnar" })).status).toBe(202);
    expect((await m.tools({ op: "compat-run", actor: "Ragnar" })).status).toBe(409);
    expect((await m.getState()).compat?.running).toBe(true);
    await Bun.sleep(1600);
    now += 2000;
    const after = (await m.getState()).compat!;
    expect(after.running).toBe(false);
    expect(after.result?.trigger).toBe("manual");
    ac.abort();
    m.stop();
    await streaming.catch(() => undefined);
    expect(seen.filter((e) => e.type === "compat").map((e) => e.data.running)).toEqual([true, false]);
    expect(seen.some((e) => e.type === "admin" && e.data.command === "compat-check" && e.data.actor === "Ragnar")).toBe(true);
    for (const mode of ["ok", "warn", "pending"]) expect(mockCompat(mode, "l-1.0.17", 40, T0).result?.status).toBe(mode === "warn" ? "warn" : "ok");
    expect(mockCompat("none", "l-1.0.17", 40, T0).result).toBeNull();
  });
});

describe("HttpAgent compat-run", () => {
  it("posts to /compat/run with the actor", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true }, { status: 202 });
    }) as unknown as typeof fetch;
    const res = await new HttpAgent("http://agent", "tok", fetchImpl).tools({ op: "compat-run", actor: "Freya" });
    expect(res).toEqual({ status: 202, body: { ok: true } });
    expect(calls[0]!.url).toBe("http://agent/compat/run");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["X-Skald-Actor"]).toBe("Freya");
  });
});
