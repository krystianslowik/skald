import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { describe as describeEvent } from "../Saga";
import { I18nProvider, makeI18n } from "../../i18n";
import { left, minutesLabel } from "../../lib/safeRestart";
import { preloadLazyChunks } from "../../test-preload";
import { emptyAgentState, SAFE_RESTART_STEPS, type AdminStatus, type AgentEvent, type ApiState, type SafeRestartRun, type SafeRestartStepState } from "../../types";
import { AdminProvider } from "./AdminContext";
import { SafeRestartSection } from "./SafeRestart";

// Fictional names and codes only.
function fixture(run: SafeRestartRun | null | undefined, players = 2): ApiState {
  const s = emptyAgentState(new Date("2026-10-09T20:00:00Z"));
  s.server = { ...s.server, name: "My Valheim", world: "Midgard", status: "running" };
  const all: ApiState["players"] = [
    { name: "Ragnar", since: "2026-10-09T19:30:00Z", platform: "xbox" },
    { name: "Freya", since: "2026-10-09T19:40:00Z", platform: "steam" },
  ];
  s.players = all.slice(0, players);
  const st: ApiState = { ...s, online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } };
  if (run !== undefined) st.safeRestart = run;
  return st;
}

function run(edit: Partial<SafeRestartRun> = {}, steps: Partial<Record<string, SafeRestartStepState>> = {}, extra: Partial<Record<string, { reason?: string; error?: string }>> = {}): SafeRestartRun {
  return {
    id: "20261009-200000",
    actor: "Jarl",
    request: { whenEmpty: true, deadlineMinutes: 60, warnMinutes: 5, locale: "en" },
    state: "running",
    step: "wait",
    steps: SAFE_RESTART_STEPS.map((name) => ({ name, state: steps[name] ?? "pending", ...extra[name] })),
    startedAt: "2026-10-09T20:00:00Z",
    forced: false,
    warned: false,
    ...edit,
  };
}

const STATUS: AdminStatus = {
  required: false,
  unlocked: true,
  idleMs: 1_800_000,
  notifyConfigured: false,
  bridge: { available: true, gameBuild: "l-1.0.17", worldLoaded: true, timeFrozen: false, tested: true, acknowledged: false, testedBuilds: ["l-1.0.17"], commands: [] },
};

function api() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/admin/status") return Response.json(STATUS);
      if (url === "/api/admin/safe-restart") return Response.json({ ok: true }, { status: method === "POST" ? 202 : 200 });
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

const show = (state: ApiState, locale: "en" | "pl" = "en") =>
  render(
    <I18nProvider locale={locale}>
      <AdminProvider state={state} online onUnauthorized={() => {}} onShowMap={() => {}}>
        <SafeRestartSection />
      </AdminProvider>
    </I18nProvider>,
  );

beforeAll(preloadLazyChunks);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("safe restart section", () => {
  it("says an old agent cannot do it", () => {
    api();
    show(fixture(undefined));
    expect(screen.getByText("The agent is too old for this; update it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Restart safely/ })).toBeNull();
  });

  it("starts a run with the chosen wait, deadline and countdown after a hold", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = api();
    show(fixture(null));
    fireEvent.click(screen.getByRole("button", { name: "2 h" }));
    fireEvent.click(screen.getByRole("button", { name: "10 min" }));
    const go = screen.getByRole("button", { name: /Restart safely/ });
    fireEvent.pointerDown(go, { pointerId: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1700);
    });
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/safe-restart")).toMatchObject({ method: "POST", body: { whenEmpty: true, deadlineMinutes: 120, warnMinutes: 10 } }));
  });

  it("drops the deadline when it does not wait for an empty server", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = api();
    show(fixture(null));
    fireEvent.click(screen.getByRole("button", { name: "Wait until nobody plays" }));
    expect(screen.queryByRole("button", { name: "No deadline" })).toBeNull();
    const go = screen.getByRole("button", { name: /Restart safely/ });
    fireEvent.pointerDown(go, { pointerId: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1700);
    });
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/safe-restart")?.body).toEqual({ whenEmpty: false, deadlineMinutes: 0, warnMinutes: 5 }));
  });

  it("shows a waiting run with the players, the deadline and a cancel", async () => {
    const calls = api();
    show(fixture(run({ deadline: new Date(Date.now() + 3_600_000).toISOString() }, { wait: "running" })));
    expect(screen.getByRole("status")).toHaveTextContent(/Waiting for an empty server, 2 online\. Goes ahead anyway in (59:5\d|1:00:00)\./);
    fireEvent.click(screen.getByRole("button", { name: "Cancel the restart" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/safe-restart")).toMatchObject({ method: "DELETE" }));
    expect(screen.queryByRole("button", { name: /Restart safely/ })).toBeNull();
  });

  it("counts down, and has no cancel past the countdown", () => {
    api();
    const { rerender } = show(fixture(run({ step: "countdown", restartAt: new Date(Date.now() + 245_000).toISOString(), forced: true }, { wait: "ok", countdown: "running" }, { wait: { reason: "deadline" } })));
    expect(screen.getByRole("status")).toHaveTextContent(/Restart in 4:0[45]\. The deadline came with players still on\./);
    expect(screen.getByText("Deadline reached with players on.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel the restart" })).toBeInTheDocument();
    rerender(
      <I18nProvider locale="en">
        <AdminProvider state={fixture(run({ step: "backup" }, { wait: "ok", countdown: "ok", save: "skipped", stop: "ok", backup: "running" }, { save: { reason: "nobridge" } }))} online onUnauthorized={() => {}} onShowMap={() => {}}>
          <SafeRestartSection />
        </AdminProvider>
      </I18nProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("No turning back now: the server restarts.");
    expect(screen.getByText("Needs the admin plugin; the stop saves anyway.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel the restart" })).toBeNull();
  });

  it("shows how the last run ended: the new join code and the checked backup", () => {
    api();
    const steps = Object.fromEntries(SAFE_RESTART_STEPS.map((s) => [s, "ok" as const]));
    show(fixture(run({ state: "done", step: "recover", endedAt: "2026-10-09T20:05:00Z", joinCode: "771203", archive: "pre-restart-20261009-200400.zip", archiveBytes: 31_000_000 }, steps)));
    expect(screen.getByText("Done. The server is back.")).toBeInTheDocument();
    expect(screen.getByText("771203")).toBeInTheDocument();
    expect(screen.getByText(/Backup: pre-restart-20261009-200400\.zip, 31(\.0)? MB, checked/)).toBeInTheDocument();
    // A new one can start.
    expect(screen.getByRole("button", { name: /Restart safely/ })).toBeInTheDocument();
  });

  it("shows a failed verify with the kept backup and the failed step, in Polish too", () => {
    api();
    const failed = run(
      { state: "failed", step: "recover", endedAt: "2026-10-09T20:05:00Z", error: "verify: no complete world", archive: "pre-restart-20261009-200400.zip" },
      { wait: "ok", countdown: "skipped", save: "ok", stop: "ok", backup: "ok", verify: "error", start: "ok", recover: "ok" },
      { verify: { error: "no complete world" } },
    );
    const { unmount } = show(fixture(failed));
    expect(screen.getByRole("alert")).toHaveTextContent("The safe restart failed: verify: no complete world");
    expect(screen.getByText("The backup is kept as pre-restart-20261009-200400.zip.")).toBeInTheDocument();
    expect(within(screen.getByRole("list")).getByText("no complete world")).toBeInTheDocument();
    unmount();
    show(fixture(failed), "pl");
    expect(screen.getByRole("alert")).toHaveTextContent("Bezpieczny restart się nie udał: verify: no complete world");
    expect(screen.getByText("Sprawdź kopię")).toBeInTheDocument();
  });

  it("says when the game had to be stopped harder", () => {
    api();
    const steps = Object.fromEntries(SAFE_RESTART_STEPS.map((s) => [s, "ok" as const]));
    show(fixture(run({ state: "done", step: "recover", endedAt: "2026-10-09T20:05:00Z", warning: "the game did not shut down in time" }, { ...steps, stop: "warn" })));
    expect(screen.getByText("The game did not shut down in time and had to be stopped harder: check the world.")).toBeInTheDocument();
  });

  it("says who cancelled", () => {
    api();
    show(fixture(run({ state: "cancelled", step: "wait", cancelledBy: "Astrid", endedAt: "2026-10-09T20:01:00Z" }, { wait: "cancelled" })));
    expect(screen.getByText("Astrid cancelled the restart.")).toBeInTheDocument();
  });
});

describe("safe restart in the saga", () => {
  const i = makeI18n("en");
  const ev = (step: string, result: string, r: SafeRestartRun): AgentEvent => ({ seq: 1, ts: "2026-10-09T20:00:00Z", type: "restart_run", data: { step, result, actor: r.actor, run: r } });

  it("tells the story, not every step", () => {
    const r = run();
    expect(describeEvent(i, ev("begin", "running", r))).toEqual({ text: "Jarl started a safe restart for when nobody plays", tone: "action" });
    expect(describeEvent(i, ev("wait", "running", r))).toBeNull();
    expect(describeEvent(i, ev("wait", "ok", r))?.text).toBe("The server is empty: the safe restart goes ahead");
    expect(describeEvent(i, ev("countdown", "running", { ...r, forced: true }))?.text).toBe("Deadline reached with players on: safe restart in 5 min");
    expect(describeEvent(i, ev("stop", "ok", r))).toBeNull();
    expect(describeEvent(i, ev("verify", "ok", { ...r, archive: "pre-restart-20261009-200400.zip", archiveBytes: 2_000_000 }))?.text).toMatch(/^World backup pre-restart-20261009-200400\.zip checked \(2(\.0)? MB\)$/);
    expect(describeEvent(i, ev("end", "done", { ...r, state: "done", joinCode: "771203" }))?.text).toBe("Safe restart done, join code 771203");
    expect(describeEvent(i, ev("end", "cancelled", { ...r, state: "cancelled", cancelledBy: "dashboard-abc123" }))?.text).toBe("An admin called off the safe restart");
  });

  it("marks failures", () => {
    const r = run({}, { recover: "error" }, { recover: { reason: "join_code_missing", error: "no join code in time" } });
    expect(describeEvent(i, ev("recover", "error", r))).toEqual({ text: "Safe restart, Wait for the world and the join code: No join code in time.", tone: "death" });
    expect(describeEvent(i, ev("end", "failed", { ...r, state: "failed" }))).toEqual({ text: "Safe restart failed", tone: "death" });
  });

  it("formats times and minutes", () => {
    expect(left(245_000)).toBe("4:05");
    expect(left(3_723_000)).toBe("1:02:03");
    expect(left(-5)).toBe("0:00");
    expect(minutesLabel(i, 120)).toBe("2 h");
    expect(minutesLabel(i, 30)).toBe("30 min");
  });
});
