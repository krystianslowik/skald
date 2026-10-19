import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPin } from "@server/pintypes";
import { I18nProvider } from "../../i18n";
import { resetPins, setPinName, setPins, usePins } from "../../lib/webpins";
import { PinSheet } from "./PinSheet";

const pin = (over: Partial<WebPin> = {}): WebPin => ({
  id: "a",
  x: 10,
  z: 20,
  icon: "dungeon",
  note: "Crypt",
  author: "Ragnar",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  state: "new",
  claimedBy: null,
  stateBy: "Ragnar",
  stateAt: 1,
  archived: false,
  ...over,
});

/** The sheet as the map opens it: the pin read from the store, closing drops it. */
function Harness({ onClose }: { onClose: () => void }) {
  const { pins } = usePins();
  return (
    <I18nProvider locale="en">
      <PinSheet mode={{ kind: "view", id: "a" }} pins={pins} onClose={onClose} />
    </I18nProvider>
  );
}

/** Pin writes wait for `answer`; nothing else is asked. */
function holdWrites() {
  const held: { method: string; body: Record<string, unknown> | undefined; answer: (r: Response) => void }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((answer) => held.push({ method: init?.method ?? "GET", body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined, answer })),
    ),
  );
  return held;
}

beforeEach(() => {
  resetPins();
  setPinName("Freya");
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("pin sheet changes", () => {
  it("show a claim on the tap, before the server answers, and keep it after", async () => {
    const held = holdWrites();
    setPins([pin()]);
    render(<Harness onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    expect(screen.getByText("Claimed by Freya")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drop claim" })).toBeEnabled();
    await waitFor(() => expect(held).toHaveLength(1));
    expect(held[0]!.body).toEqual({ by: "Freya", state: "claimed", expect: { state: "new", claimedBy: null } });
    await act(async () => held[0]!.answer(Response.json({ ok: true, pin: pin({ state: "claimed", claimedBy: "Freya", stateBy: "Freya", version: 2 }) })));
    expect(screen.getByText("Claimed by Freya")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("go back to the server's copy and say so when the change fails", async () => {
    const held = holdWrites();
    setPins([pin()]);
    render(<Harness onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Cleared" }));
    expect(screen.getByText("Cleared by Freya")).toBeInTheDocument();
    await waitFor(() => expect(held).toHaveLength(1));
    await act(async () => held[0]!.answer(Response.json({ ok: false, error: "rate_limited" }, { status: 429 })));
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Too many changes at once");
  });

  it("show the other player's change on a 409 stale", async () => {
    const held = holdWrites();
    setPins([pin()]);
    render(<Harness onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    await waitFor(() => expect(held).toHaveLength(1));
    const theirs = pin({ state: "claimed", claimedBy: "Bjorn", stateBy: "Bjorn", version: 2 });
    await act(async () => held[0]!.answer(Response.json({ ok: false, error: "stale", pin: theirs }, { status: 409 })));
    expect(screen.getByText("Claimed by Bjorn")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Someone changed this pin first");
  });

  it("archive at once, and a second tap goes out after the first with its result as the guard", async () => {
    const held = holdWrites();
    setPins([pin()]);
    render(<Harness onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByText(/archived/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    await waitFor(() => expect(held).toHaveLength(1));
    await act(async () => held[0]!.answer(Response.json({ ok: true, pin: pin({ archived: true, version: 2 }) })));
    // The first answer does not flip the button back.
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    await waitFor(() => expect(held).toHaveLength(2));
    expect(held[1]!.body).toEqual({ by: "Freya", archived: false, expect: { archived: true } });
    await act(async () => held[1]!.answer(Response.json({ ok: true, pin: pin({ archived: false, version: 3 }) })));
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });

  it("close on delete at once; a refused delete brings the pin back with the reason", async () => {
    const held = holdWrites();
    setPins([pin({ archived: true })]);
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete for good" }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByText("Pin deleted")).toBeInTheDocument();
    await waitFor(() => expect(held).toHaveLength(1));
    await act(async () => held[0]!.answer(Response.json({ ok: false, error: "not_archived" }, { status: 409 })));
    expect(screen.getByRole("alert")).toHaveTextContent("Archive the pin first");
  });

  it("an edit closes the editor at once and opens it again with the typed text on a refusal", async () => {
    const held = holdWrites();
    setPins([pin()]);
    render(<Harness onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const note = screen.getByDisplayValue("Crypt");
    fireEvent.change(note, { target: { value: "Two rooms" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByDisplayValue("Two rooms")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Two rooms" })).toBeInTheDocument();
    await waitFor(() => expect(held).toHaveLength(1));
    await act(async () => held[0]!.answer(new Response("{}", { status: 500 })));
    expect(screen.getByDisplayValue("Two rooms")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Crypt" })).toBeInTheDocument();
  });
});
