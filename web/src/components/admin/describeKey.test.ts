import { describe, expect, it } from "vitest";
import { describeKey } from "./AdminPanel";

const words: Record<string, string> = { "admin.keys.preset": "World modifiers", "admin.keys.presetDefault": "all default", "mod.resources": "resources", "mod.portals": "portals", "modv.muchmore": "much more", "modv.casual": "casual", "gkey.resourcerate": "Resource rate" };
const t = (k: string) => words[k] ?? k;
const lookup = (k: string) => words[k];

describe("describeKey", () => {
  it("turns the world's preset key into readable modifiers, skipping defaults", () => {
    const r = describeKey("preset combat_default:deathpenalty_default:resources_muchmore:raids_default:portals_casual", t as never, lookup);
    expect(r).toEqual({ title: "World modifiers", detail: "resources: much more, portals: casual" });
  });
  it("says all default when nothing was changed", () => {
    expect(describeKey("preset combat_default:raids_default", t as never, lookup).detail).toBe("all default");
  });
  it("names a key with a value", () => {
    expect(describeKey("resourcerate 200", t as never, lookup)).toEqual({ title: "Resource rate", detail: "200" });
  });
  it("falls back to the raw key", () => {
    expect(describeKey("killed_surtling", t as never, lookup)).toEqual({ title: "killed_surtling", detail: "" });
  });
});
