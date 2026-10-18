import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, expect, it } from "vitest";
import { Sheet } from "./Sheet";
import { sheetPending } from "../lib/sheetHistory";
import { useRoute } from "../lib/useRoute";

// Its own file: the sheet history starts listening at the first sheet, so here,
// as in the app, the tabs' popstate listener runs before it.

function Details() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open details
      </button>
      {open && (
        <Sheet labelledBy="details-h" onClose={() => setOpen(false)} header={() => <h2 id="details-h">details</h2>}>
          <p>details body</p>
        </Sheet>
      )}
    </>
  );
}

const settled = () => waitFor(() => expect(sheetPending()).toBe(false));

// A browser runs microtasks between popstate listeners, so React renders whatever the
// tabs' listener set before the sheet history's runs. jsdom does not: render there.
const between = () => flushSync(() => {});
afterEach(() => window.removeEventListener("popstate", between));

it("never shows the tab under a sheet while stepping over it to the map", async () => {
  history.replaceState(null, "", "/");
  const seen: string[] = [];
  const { result } = renderHook(() => {
    const r = useRoute();
    seen.push(r[0]);
    return r;
  });
  render(<Details />);
  window.addEventListener("popstate", between);
  fireEvent.click(screen.getByText("open details"));
  await settled();
  seen.length = 0;
  act(() => result.current[1]("map"));
  await waitFor(() => expect(location.hash).toBe("#map"));
  await settled();
  // The map drops the stores' focus whenever it closes, so it must not close for a render on the way.
  expect(seen.filter((t) => t !== "map")).toEqual([]);
  expect(result.current[0]).toBe("map");

  // Back still works afterwards: it closes the sheet that stayed open, then the map.
  await act(async () => {
    history.back();
    await new Promise((r) => setTimeout(r, 20));
  });
  await settled();
  await waitFor(() => expect(screen.queryByRole("heading", { name: "details" })).toBeNull());
  expect(result.current[0]).toBe("map");
  await act(async () => {
    history.back();
    await new Promise((r) => setTimeout(r, 20));
  });
  await waitFor(() => expect(result.current[0]).toBe("fire"));
  expect(location.hash).toBe("");
});
