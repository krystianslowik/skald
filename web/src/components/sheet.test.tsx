import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The system's reduced-motion setting, as motion reports it.
let reducedMotion = false;
vi.mock("motion/react", async (importOriginal) => ({ ...(await importOriginal<typeof import("motion/react")>()), useReducedMotion: () => reducedMotion }));
import { SCRIM_REST, Sheet } from "./Sheet";

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

  it("closes on a press that starts and ends on the scrim", async () => {
    const { onDismiss } = mount();
    // Once the sheet holds its history entry, the scrim steps back over it and the popstate closes it.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.pointerDown(scrimOf());
    fireEvent.click(scrimOf());
    await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
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

describe("Sheet scrim blur", () => {
  afterEach(() => {
    reducedMotion = false;
  });
  const blurred = () => scrimOf().classList.contains(SCRIM_REST);

  // A backdrop blur under a moving sheet re-samples the screen every frame: weaker GPUs drop most of them.
  it("blurs only while the sheet rests, not while it slides in or out", async () => {
    const { onClose } = mount();
    expect(blurred()).toBe(false);
    await waitFor(() => expect(blurred()).toBe(true));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(blurred()).toBe(false);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("keeps the blur through a tap on the header, and drops it once a drag starts", async () => {
    mount();
    await waitFor(() => expect(blurred()).toBe(true));
    const header = document.querySelector("header")!;
    fireEvent.pointerDown(header, { button: 0, clientX: 0, clientY: 0 });
    expect(blurred()).toBe(true);
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    expect(blurred()).toBe(true);
    fireEvent.pointerDown(header, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0 });
    expect(blurred()).toBe(false);
    // Let go close to where it rests: it springs back open and the blur returns.
    fireEvent.pointerUp(window, { clientX: 40, clientY: 0 });
    await waitFor(() => expect(blurred()).toBe(true));
  });

  it("under reduced motion, blurs once the fade-in is done", async () => {
    reducedMotion = true;
    mount();
    expect(blurred()).toBe(false);
    await waitFor(() => expect(blurred()).toBe(true));
  });
});
