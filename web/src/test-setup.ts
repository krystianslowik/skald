import "@testing-library/jest-dom";

// jsdom gaps: matchMedia (motion's reduced-motion hook), canvas, ResizeObserver, WebSocket.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
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
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close() {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
