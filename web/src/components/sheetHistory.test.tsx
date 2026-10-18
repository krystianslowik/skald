import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Sheet } from "./Sheet";
import { sheetDepth, sheetPending } from "../lib/sheetHistory";
import { useRoute } from "../lib/useRoute";

/** Lets our own traversals land and the reconcile run. */
const settled = () => waitFor(() => expect(sheetPending()).toBe(false));
const back = async () => {
  await act(async () => {
    history.back();
    await new Promise((r) => setTimeout(r, 20));
  });
  await settled();
};

function Board({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <Sheet
      labelledBy={`${name}-h`}
      onClose={onClose}
      header={(close) => (
        <>
          <h2 id={`${name}-h`}>{name}</h2>
          <button type="button" onClick={close}>
            close {name}
          </button>
        </>
      )}
    >
      <p>{name} body</p>
    </Sheet>
  );
}

/** A page with a details sheet that can open a profile over it, and a sheet that can swap for another. */
function Page() {
  const [details, setDetails] = useState(false);
  const [profile, setProfile] = useState(false);
  const [view, setView] = useState<null | "panel" | "fill">(null);
  return (
    <>
      <button type="button" onClick={() => setDetails(true)}>
        open details
      </button>
      <button type="button" onClick={() => setView("panel")}>
        open panel
      </button>
      {details && <Board name="details" onClose={() => setDetails(false)} />}
      {details && (
        <button type="button" onClick={() => setProfile(true)}>
          open profile
        </button>
      )}
      {profile && <Board name="profile" onClose={() => setProfile(false)} />}
      {view === "panel" && (
        <>
          <Board name="panel" onClose={() => setView(null)} />
          <button type="button" onClick={() => setView("fill")}>
            to fill
          </button>
        </>
      )}
      {view === "fill" && <Board name="fill" onClose={() => setView("panel")} />}
    </>
  );
}

const gone = (name: string) => waitFor(() => expect(screen.queryByRole("heading", { name })).toBeNull());
const startLength = () => history.length;

afterEach(async () => {
  await settled();
});

describe("sheets and the Back button", () => {
  it("pushes an entry when a sheet opens, and Back closes it without touching the hash", async () => {
    history.replaceState(null, "", "/#saga");
    render(<Page />);
    const base = startLength();
    fireEvent.click(screen.getByText("open details"));
    await settled();
    expect(sheetDepth()).toBe(1);
    expect(history.length).toBe(base + 1);
    expect(location.hash).toBe("#saga");
    await back();
    await gone("details");
    expect(sheetDepth()).toBe(0);
    expect(location.hash).toBe("#saga");
  });

  it("unwinds nested sheets one per Back", async () => {
    render(<Page />);
    fireEvent.click(screen.getByText("open details"));
    await settled();
    fireEvent.click(screen.getByText("open profile"));
    await settled();
    expect(sheetDepth()).toBe(2);
    await back();
    await gone("profile");
    expect(screen.getByRole("heading", { name: "details" })).toBeInTheDocument();
    expect(sheetDepth()).toBe(1);
    await back();
    await gone("details");
    expect(sheetDepth()).toBe(0);
  });

  it("starts leaving at once when closed with the button, before history catches up", async () => {
    render(<Page />);
    fireEvent.click(screen.getByText("open details"));
    await settled();
    fireEvent.click(screen.getByText("close details"));
    // Released synchronously: the step back is already on its way.
    expect(sheetPending()).toBe(true);
    await settled();
    await gone("details");
  });

  it("closing with the button steps back over the entry, leaving no dead Back", async () => {
    render(<Page />);
    fireEvent.click(screen.getByText("open details"));
    await settled();
    const top = history.length;
    fireEvent.click(screen.getByText("close details"));
    // A double tap must not step back twice.
    fireEvent.click(screen.getByText("close details"));
    await settled();
    await gone("details");
    expect(sheetDepth()).toBe(0);
    expect(history.state?.skaldSheet).toBeUndefined();
    // The sheet's entry is now forward history, not under the page.
    expect(history.length).toBe(top);
  });

  it("a sheet that hands over to another in one render keeps one entry", async () => {
    render(<Page />);
    fireEvent.click(screen.getByText("open panel"));
    await settled();
    const top = history.length;
    fireEvent.click(screen.getByText("to fill"));
    await settled();
    expect(screen.getByRole("heading", { name: "fill" })).toBeInTheDocument();
    expect(sheetDepth()).toBe(1);
    expect(history.length).toBe(top);
    // Back from the fill returns to the panel, which holds its own entry again.
    await back();
    await screen.findByRole("heading", { name: "panel" });
    await gone("fill");
    await settled();
    expect(sheetDepth()).toBe(1);
    await back();
    await gone("panel");
    expect(sheetDepth()).toBe(0);
  });
});

describe("tabs with a sheet open", () => {
  it("steps back over the sheet's entry before moving to another tab", async () => {
    history.replaceState(null, "", "/");
    render(<Page />);
    const { result } = renderHook(() => useRoute());
    fireEvent.click(screen.getByText("open details"));
    await settled();
    act(() => result.current[1]("map"));
    await settled();
    await waitFor(() => expect(location.hash).toBe("#map"));
    expect(result.current[0]).toBe("map");
    // The details sheet stayed open: it holds a fresh entry over the map's.
    expect(sheetDepth()).toBe(1);
    expect(history.state).toMatchObject({ skaldMap: true, skaldSheet: 1 });
    // Closing the map from under the sheet lands on the fire, not on the map behind the sheet.
    act(() => result.current[1]("fire"));
    await settled();
    await waitFor(() => expect(location.hash).toBe(""));
    expect(result.current[0]).toBe("fire");
  });

  it("the last tab tapped wins while the sheets are still being stepped over", async () => {
    history.replaceState(null, "", "/#saga");
    render(<Page />);
    const { result } = renderHook(() => useRoute());
    fireEvent.click(screen.getByText("open details"));
    await settled();
    act(() => {
      result.current[1]("map");
      result.current[1]("saga");
    });
    await settled();
    expect(location.hash).toBe("#saga");
    expect(result.current[0]).toBe("saga");
  });
});
