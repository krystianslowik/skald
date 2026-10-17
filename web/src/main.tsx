import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";

// The app's script ran: the boot watchdog in index.html stands down.
document.documentElement.setAttribute("data-booted", "");

// iOS Safari only applies :active (the press feedback) when a touch listener exists.
document.addEventListener("touchstart", () => undefined, { passive: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// App-shell service worker (installable PWA); dev and tests never register it.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    // Installed to the home screen: ask that the kept terrain tiles survive storage pressure (granted quietly or not at all there).
    if (matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone) void navigator.storage?.persist?.().catch(() => false);
  });
}
