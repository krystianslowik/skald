import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogStore } from "../lib/useValheim";
import { emptyAgentState, type AdminStatus, type ApiState } from "../types";
import { Dashboard } from "./Dashboard";

function fixture(): ApiState {
  const s = emptyAgentState(new Date("2026-10-09T20:00:00Z"));
  s.server = { ...s.server, name: "My Valheim", world: "Midgard", status: "running", version: "l-1.0.17", joinCode: "482915", joinCodeAt: "2026-10-09T19:00:00Z" };
  s.settings = { enabled: true, pending: false, armed: false, passwordSet: true };
  return { ...s, online: true, metricsConfigured: false, metrics: null, history: { players: [], events: [], online7d: [] } };
}

const status = (unlocked: boolean): AdminStatus => ({
  required: true,
  unlocked,
  idleMs: 1_800_000,
  bridge: { available: false, reason: "off", tested: false, acknowledged: false, testedBuilds: [], commands: [] } as unknown as AdminStatus["bridge"],
});

/** The panel's API with an admin password set: the password and the settings sheet are the admin's. */
function api(unlocked: boolean) {
  const calls: string[] = [];
  let open = unlocked;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u === "/api/admin/status") return Response.json(status(open));
      if (u === "/api/admin/unlock") {
        open = true;
        return Response.json({ ok: true });
      }
      if (u === "/api/settings/password") return open ? Response.json({ password: "hearth-77" }) : Response.json({ ok: false, error: "admin_required" }, { status: 403 });
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

const renderDashboard = () => render(<Dashboard live={{ state: fixture(), logs: createLogStore(), online: true, lastAction: null }} onLogout={() => {}} />);

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("server settings behind an admin password", () => {
  it("asks a viewer to unlock before the sheet opens, and stays shut when they back out", async () => {
    const calls = api(false);
    renderDashboard();
    await waitFor(() => expect(calls).toContain("/api/admin/status"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Server settings" }));
    const unlock = await screen.findByRole("dialog", { name: "Admin password" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    fireEvent.keyDown(unlock, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Admin password" })).not.toBeInTheDocument());
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(calls).not.toContain("/api/settings");
    expect(calls).not.toContain("/api/settings/password");
  });

  it("opens the sheet once unlocked", async () => {
    const calls = api(false);
    renderDashboard();
    await waitFor(() => expect(calls).toContain("/api/admin/status"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Server settings" }));
    const unlock = await screen.findByRole("dialog", { name: "Admin password" });
    fireEvent.change(within(unlock).getByLabelText("Admin password"), { target: { value: "jarl" } });
    fireEvent.click(within(unlock).getByRole("button", { name: "Unlock" }));
    fireEvent.click(await within(unlock).findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain("/api/settings"));
  });

  it("does not hand a viewer the server password on the join panel", async () => {
    const calls = api(false);
    renderDashboard();
    await waitFor(() => expect(calls).toContain("/api/admin/status"));
    await act(async () => {});
    // Sharing takes the code alone: no "include password" switch.
    expect(screen.queryByRole("checkbox", { name: "Include password" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(await screen.findByRole("dialog", { name: "Admin password" })).toBeInTheDocument();
    expect(screen.queryByText("hearth-77")).not.toBeInTheDocument();
  });

  it("shows it to an unlocked admin", async () => {
    const calls = api(true);
    renderDashboard();
    await waitFor(() => expect(calls).toContain("/api/admin/status"));
    await act(async () => {});
    expect(screen.getByRole("checkbox", { name: "Include password" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(await screen.findByText("hearth-77")).toBeInTheDocument();
  });
});
