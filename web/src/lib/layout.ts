/**
 * Prototype switch for the Atlas main screen. `?layout=atlas` turns it on and
 * remembers it in this browser; `?layout=default` turns it off again. Without
 * either the stored choice stands, and with nothing stored the default layout
 * renders exactly as before.
 */
const KEY = "skald.layout";

export type Layout = "default" | "atlas";

export function chosenLayout(search = globalThis.location?.search ?? ""): Layout {
  const asked = new URLSearchParams(search).get("layout");
  try {
    if (asked === "atlas") localStorage.setItem(KEY, "atlas");
    else if (asked === "default") localStorage.removeItem(KEY);
    else return localStorage.getItem(KEY) === "atlas" ? "atlas" : "default";
  } catch {
    // storage blocked: the query alone decides
  }
  return asked === "atlas" ? "atlas" : "default";
}
