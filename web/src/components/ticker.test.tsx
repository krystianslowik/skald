import { act, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogStore } from "../lib/useValheim";
import { emptyAgentState, type ApiState } from "../types";
import { Dashboard } from "./Dashboard";

// Every board sits in a Plank, and a Plank renders whenever the dashboard does.
let plankRenders = 0;
vi.mock("./Plank", async (importOriginal) => {
  const real = await importOriginal<typeof import("./Plank")>();
  return {
    Plank: (props: ComponentProps<typeof real.Plank>) => {
      plankRenders += 1;
      return <real.Plank {...props} />;
    },
  };
});

const NOW = Date.parse("2026-10-09T20:00:00Z");

function fixture(): ApiState {
  const s = emptyAgentState(new Date(NOW));
  s.server = { ...s.server, name: "Midgard", status: "running", joinCode: "482915", joinCodeAt: "2026-10-09T19:00:00Z", serverStartedAt: "2026-10-09T18:00:00Z" };
  s.players = [{ name: "Ragnar", since: "2026-10-09T19:30:00Z" }];
  s.backups = [{ name: "worlds-20261009-180000.zip", sizeBytes: 41_000_000, modifiedAt: "2026-10-09T18:00:00Z" }];
  return {
    ...s,
    online: true,
    metricsConfigured: false,
    metrics: null,
    history: {
      players: [{ name: "Freya", sessions: 3, playtimeMs: 10_800_000, deaths: 2, lastSeen: "2026-10-09T19:00:00Z", online: false }],
      events: [{ seq: 1, ts: "2026-10-09T19:40:00Z", type: "death", data: { name: "Ragnar" } }],
      online7d: [],
    },
  };
}

beforeEach(() => {
  plankRenders = 0;
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("relative times", () => {
  it("tick in the labels alone, without re-rendering the dashboard", async () => {
    history.replaceState(null, "", "/");
    render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={async () => "ok" as const} />);
    // Let the boards' own fetches settle first.
    await act(async () => {});
    // Burning for 2 h, Ragnar at the fire for 30 min, Freya last seen an hour ago.
    expect(screen.getByText("2 h")).toBeInTheDocument();
    expect(screen.getByText("30 min")).toBeInTheDocument();
    const before = plankRenders;
    expect(before).toBeGreaterThan(0);

    act(() => vi.advanceTimersByTime(5 * 60_000));

    expect(screen.getByText("2 h 5 min")).toBeInTheDocument();
    expect(screen.getByText("35 min")).toBeInTheDocument();
    expect(plankRenders).toBe(before);
  });
});
