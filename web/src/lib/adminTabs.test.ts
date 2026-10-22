import { afterEach, describe, expect, it, vi } from "vitest";
import { adminHash, forgetTab, isAdminHash, PANEL_SECTIONS, parseAdminHash, rememberedTab, rememberTab, tabOf } from "./adminTabs";

afterEach(() => {
  vi.unstubAllGlobals();
  forgetTab();
  localStorage.removeItem("skald.admin.tab");
});

describe("links into the admin sheet", () => {
  it("reads a tab, a section, or the sheet alone", () => {
    expect(parseAdminHash("#admin")).toEqual({});
    expect(parseAdminHash("#admin/")).toEqual({});
    expect(parseAdminHash("#admin/world")).toEqual({ tab: "world" });
    expect(parseAdminHash("#admin/compat")).toEqual({ section: "compat" });
    expect(parseAdminHash("#admin/Discord")).toEqual({ section: "discord" });
    // Something it does not know still opens the sheet, as it would open anyway.
    expect(parseAdminHash("#admin/nope")).toEqual({});
  });

  it("leaves every other hash to the page's own tabs", () => {
    for (const h of ["", "#", "#map", "#saga", "#settings", "#administrator", "#admins/world"]) {
      expect(isAdminHash(h)).toBe(false);
      expect(parseAdminHash(h)).toBeNull();
    }
  });

  it("puts every section on a tab, and writes the hash back the way it reads", () => {
    for (const s of Object.keys(PANEL_SECTIONS) as (keyof typeof PANEL_SECTIONS)[]) {
      expect(["players", "world", "base", "server"]).toContain(tabOf(s));
      expect(parseAdminHash(adminHash(s))).toEqual({ section: s });
    }
    expect(tabOf("compat")).toBe("server");
    expect(tabOf("keys")).toBe("world");
    // Moved off the long server tab: saving with the world, your name and lock with the players.
    expect(tabOf("save")).toBe("world");
    expect(tabOf("you")).toBe("players");
  });
});

describe("the remembered tab", () => {
  it("is kept per browser", () => {
    expect(rememberedTab()).toBeNull();
    rememberTab("base");
    expect(localStorage.getItem("skald.admin.tab")).toBe("base");
    forgetTab();
    expect(rememberedTab()).toBe("base");
    localStorage.setItem("skald.admin.tab", "attic");
    expect(rememberedTab()).toBeNull();
  });

  it("is kept for the visit when storage refuses it", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(rememberedTab()).toBeNull();
    rememberTab("server");
    expect(rememberedTab()).toBe("server");
  });
});
