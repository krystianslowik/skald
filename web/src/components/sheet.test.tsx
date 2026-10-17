import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

const scrimOf = () => document.querySelector<HTMLElement>(".sheet-scrim")!;

function mount() {
  const onClose = vi.fn();
  const onDismiss = vi.fn();
  render(
    <Sheet labelledBy="t-h" onClose={onClose} onDismiss={onDismiss} header={() => <h2 id="t-h">Test</h2>}>
      <p>body</p>
    </Sheet>,
  );
  return { onClose, onDismiss };
}

describe("Sheet scrim", () => {
  // A tap on the map that opens a sheet (finishing "Pick on map") ends in a
  // click the browser hit-tests against the freshly mounted scrim.
  it("ignores a click that did not start on the scrim", () => {
    const { onDismiss } = mount();
    fireEvent.click(scrimOf());
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("closes on a press that starts and ends on the scrim", () => {
    const { onDismiss } = mount();
    fireEvent.pointerDown(scrimOf());
    fireEvent.click(scrimOf());
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not let a press that left the scrim arm a later click", () => {
    const { onDismiss } = mount();
    fireEvent.pointerDown(scrimOf());
    // Lifted elsewhere: the click goes to a common ancestor, not the scrim. Then a new press starts off the scrim.
    fireEvent.pointerDown(document.body);
    fireEvent.click(scrimOf());
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does not let a cancelled press arm a later click", () => {
    const { onDismiss } = mount();
    fireEvent.pointerDown(scrimOf());
    fireEvent.pointerCancel(scrimOf());
    fireEvent.click(scrimOf());
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
