import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { pl } from "../i18n/pl";
import { PRESET_KITS, stacksOf, stackSize } from "./admin";

const catalog = new Set(Object.keys(en).filter((key) => key.startsWith("item.")).map((key) => key.slice(5)));
const items = (name: string) => PRESET_KITS.find((kit) => kit.nameKey === `admin.items.kit.${name}`)!.lines.map((line) => line.item);

describe("ready-made kits", () => {
  it("offers seventeen translated, valid loadouts within command limits", () => {
    expect(PRESET_KITS).toHaveLength(17);
    expect(new Set(PRESET_KITS.map((kit) => kit.nameKey)).size).toBe(17);
    for (const kit of PRESET_KITS) {
      expect(en[kit.nameKey]).toBeTruthy();
      expect(pl[kit.nameKey]).toBeTruthy();
      expect(kit.lines.length).toBeGreaterThan(0);
      expect(kit.lines.length).toBeLessThanOrEqual(20);
      expect(new Set(kit.lines.map((line) => line.item)).size).toBe(kit.lines.length);
      expect(stacksOf(kit.lines, stackSize)).toBeLessThanOrEqual(60);
      for (const line of kit.lines) {
        expect(catalog.has(line.item), `${kit.name}: ${line.item}`).toBe(true);
        expect(en).toHaveProperty(`item.${line.item}`);
        expect(pl).toHaveProperty(`item.${line.item}`);
        expect(Number.isInteger(line.amount)).toBe(true);
        expect(line.amount).toBeGreaterThan(0);
        expect(Number.isInteger(line.quality)).toBe(true);
        expect(line.quality).toBeGreaterThanOrEqual(1);
        expect(line.quality).toBeLessThanOrEqual(3);
        expect(line.item).not.toMatch(/^(Trophy|Crown|DragonEgg|AncientSeed|WitheredBone|YagluthDrop|QueenDrop|FaderDrop|FrozenKingDrop)/);
      }
    }
  });

  it("matches early and mountain bosses without skipping their progression", () => {
    expect(items("eikthyr")).toEqual(expect.arrayContaining(["SpearFlint", "ShieldWood", "ArmorLeatherChest"]));
    expect(items("eikthyr")).not.toContain("PickaxeAntler");
    expect(items("elder")).toEqual(expect.arrayContaining(["BowFineWood", "ArrowFire", "ArmorBronzeChest"]));
    expect(items("bonemass")).toEqual(expect.arrayContaining(["MaceIron", "MeadPoisonResist"]));
    expect(items("moder")).toEqual(expect.arrayContaining(["BowDraugrFang", "ArrowObsidian", "ArrowPoison", "CapeWolf", "MeadFrostResist"]));
    expect(items("moder")).not.toContain("ArrowFrost");
  });

  it("prepares late-game melee fights with protection and health/stamina foods", () => {
    expect(items("yagluth")).toEqual(expect.arrayContaining(["MaceSilver", "BarleyWine", "LoxPie", "FishWraps", "Bread"]));
    expect(items("queen")).toEqual(expect.arrayContaining(["SwordMistwalker", "MeadPoisonResist", "MisthareSupreme", "MeatPlatter", "Salad"]));
    expect(items("fader")).toEqual(expect.arrayContaining(["SwordNiedhogg", "BarleyWine", "MashedMeat", "PiquantPie", "ScorchingMedley"]));
    expect(items("kall")).toEqual(expect.arrayContaining(["MaceGold", "BarleyWine", "MeadFrostResist", "MooseKebab", "SealSoup", "Pancakes"]));
    expect(items("kall")).not.toContain("MeatballsMashedPoteitr");
  });
});
