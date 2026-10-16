import { describe, expect, it } from "vitest";
import css from "./index.css?raw";
import html from "../../index.html?raw";

// Each face must be declared once, or document.fonts holds a second copy that
// is never used and stays "unloaded", and document.fonts.check() is false for good.

describe("self-hosted fonts", () => {
  it("declares every face once, in the stylesheet only", () => {
    const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => {
      const prop = (name: string) => body!.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
      return `${prop("font-family")} ${prop("font-weight")} ${prop("font-style")}`;
    });
    expect(faces).toEqual(['"Averia Serif Libre" 400 normal', '"Averia Serif Libre" 700 normal', '"Noto Sans Runic" 400 normal']);
  });

  it("adds no second font stylesheet or face in the HTML", () => {
    expect(html).not.toMatch(/@font-face|fonts\.googleapis|<style/i);
    expect(html).not.toMatch(/rel="stylesheet"/);
  });
});
