import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// findBy*/waitFor give up after 1 s by default. On a saturated machine (CI, parallel builds) mounting the
// Dashboard and opening a sheet can take longer than that, so wait up to 10 s. Passing tests are no slower.
configure({ asyncUtilTimeout: 10_000 });

// jsdom gaps: matchMedia (motion's reduced-motion hook), canvas, ResizeObserver, WebSocket.
// Everything is a desktop with a mouse unless a test sets `window.__media[query] = true`.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: !!(window as unknown as { __media?: Record<string, boolean> }).__media?.[query],
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
if (!("ResizeObserver" in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
class FakeWebSocket {
  // Never connects: CONNECTING for good, so nothing is sent over it.
  static OPEN = 1;
  readyState = 0;
  send() {}
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close() {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
// jsdom has no layout, so no scrolling.
window.scrollTo = (() => undefined) as typeof window.scrollTo;
