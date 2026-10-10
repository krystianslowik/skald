# Valheim UI: visual research for a Valheim-flavoured dashboard

Purpose: restyle the skald web dashboard (React + Tailwind, dark "campfire" theme)
so it reads as Valheim **without shipping any Iron Gate / Coffee Stain asset**.
Research date: 2026-10-10. Read-only research; no game files were extracted.

## 0. Provenance and caveats

Every claim is tagged:

- **[obs: file]**: seen in a reference screenshot (list in section 9). Hex values were
  sampled with Pillow from those files. They are JPEG/PNG captures with tonemapping,
  anti-aliasing and compression, so treat them as **approximate** (roughly +/- 8 per channel).
  The tokens in section 7 are rounded from these samples.
- **[src: URL]**: from a cited web source.
- **[unverified]**: general knowledge about the game. It was not observed in the refs and
  not confirmed by a source. Check it in-game before relying on it.

Vintage: the reference screenshots range from 2020 (press kit, pre-Early-Access) to 2023
(Mistlands main menu, v0.214.2). Shockbyte gives 1.0 as 2026-09-09
(https://shockbyte.com/blog/when-is-the-valheim-1-0-release-date), but no Iron Gate source
confirmed that date during this research. The core UI language (wood panels, Norse caps,
Averia body text, red health column) has held steady from 2021 through Mistlands. No 1.0-era
UI capture was found, so anything 1.0 changed is not covered here.

## 1. Typography

**Fonts shipped in the game** (mod authors list them from the game's font assets):

| Game font | Where it is used | Source |
|---|---|---|
| Averia Serif Libre (Light/Regular/Bold/Italic/BoldItalic) | Almost all body/UI text: item names, stats, tab labels, hints, biome name on minimap. A mod gives AveriaSerifLibre-Bold as "the game's UI font". | [src: https://thunderstore.io/c/valheim/p/Nexus/Clock/], [src: https://thunderstore.io/c/valheim/p/jp/Correct_Localization_JP/] |
| Averia Sans Libre (5 styles) | Sans companion, used in some places | same |
| Norse / Norsebold | Rune-styled display caps: window headings (WORKBENCH, player name), main menu items, large center-screen captions, boss names, player nameplates | same; [obs: windowscentral-inventory-crafting.jpg, hermitgamer-forest-is-moving.png, eurogamer-eikthyr-boss-bar.jpg, md5gaming-main-menu-mistlands.jpg] |
| rune | Actual runic glyphs, shown the first time a runestone is read | [src: Correct_Localization_JP] |
| prstart / prstartk (Press Start 2P style pixel font) | Small debug text on the title screen ("Show Player.log", version string) | [src: Correct_Localization_JP]; version string seen in [obs: md5gaming-main-menu-mistlands.jpg] |
| OpenSans, Arial | Fallbacks and text input fields | [src: Nexus/Clock], [src: Correct_Localization_JP] |

The commonly cited pair "Averia Serif Libre + Norse" is **confirmed**. Norse appears in
**all caps** with angular, chiselled strokes (the C looks like a bracket and the S like a
lightning bolt).

**Licences and web options**

| Font | Licence | Web use |
|---|---|---|
| Averia Serif Libre (Dan Sayers) | **SIL OFL 1.1**, on Google Fonts (verified in google/fonts `ofl/averiaseriflibre/METADATA.pb`) | Use directly. This is literally the game's body font. |
| Averia Sans Libre (Dan Sayers) | **OFL**, Google Fonts | Use directly. |
| Norse (Joel Carrouche) | **Freeware, not OFL.** FontSpace quotes the designer: "Norse is 100% free for personal and commercial use" (https://www.fontspace.com/norse-font-f21080). Cufon and Themes Awesome say "personal use only" (https://www.cufonfonts.com/font/norse). The designer's licence for another font (Troika) forbids redistribution without permission (https://www.fontsquirrel.com/license/troika). | **Conflicting.** Before self-hosting it as a webfont (which counts as redistribution), read the licence file in the official download or get written permission from the designer. |
| Noto Sans Runic | **OFL**, Google Fonts | Real Elder Futhark glyphs (U+16A0-16F8) only. Not usable for Latin text. |
| Germania One / MedievalSharp / Metamorphous / Pirata One | **OFL**, Google Fonts | Medieval or blackletter flavour. **None is a true Norse look-alike.** No OFL font matches Norse's runic-geometric caps. |

**Recommended stack**
- Body/UI: `"Averia Serif Libre", Georgia, serif`, weights 400/700. Bold is the dominant
  weight in-game for list items and labels [obs: windowscentral-inventory-crafting.jpg].
- Display (headings, center messages, boss names): Norse **only if** its licence is cleared.
  Otherwise use `"Averia Serif Libre"` 700, uppercase, `letter-spacing: 0.08em`. Germania One
  is an optional, more angular OFL alternative. Test both: Germania One reads as
  "medieval poster" rather than "rune-cut".
- Runic decoration: `"Noto Sans Runic"` for actual Futhark strings (e.g. a runic rendering
  of the server name as an ornament, `aria-hidden`).

## 2. Panels (what was observed)

Two distinct panel flavours:

1. **Warm wood / leather board** (inventory, crafting station, character header):
   - Fill: mid-dark warm brown with visible plank/grain texture. Samples: description area
     `#442d1d`, list area `#483221`, lighter header band `#6a4b34`, frame/rim `#644631`
     [obs: windowscentral-inventory-crafting.jpg].
   - **Opaque**, not translucent: the world does not show through.
   - Edges: irregular, slightly torn/worn silhouette with a thin darker rim and small corner
     notches. There are no CSS-style rounded corners. Effective radius is ~2-4 px plus raggedness.
   - The panel header carries a centered Norse title in amber flanked by a small carved
     knotwork ornament line ("BRENDAN" header).
2. **Dark grey-brown board** (hammer build menu):
   - Fill `#302829` to `#392f31`, desaturated purple-brown with wood grain
     [obs: press-build-menu.png]. Opaque, ragged edges, no visible border line.
   - Tab strip at top, separated from the grid by a **2-3 px amber rule** (`#fcae08` core,
     `#a1680f` median) [obs: press-build-menu.png].

HUD elements (hotbar, food icons, power icon, key chips) instead sit directly on the 3D
world, on small **semi-transparent dark squares**. For example, the hotbar slot median is
`#8e765c` over a bright sky, which means a low-alpha dark fill [obs: press-hud-forest.png,
press-build-menu.png]. The minimap has a thin brown-grey frame (`#5c443a`) and a parchment map.
Not everything is boxed: the EA main-menu changelog is an amber Averia heading plus off-white
Averia Bold text placed directly over the darkened scene with no panel at all
[obs: mmos-main-menu-ea.jpg].

Pause menu, settings screen and item-hover tooltips: **not observed** in the refs.
[unverified] The pause menu and settings use the same wood board with Norse heading and
Averia text, and tooltips are dark wood boxes with an amber item name and off-white
stat lines.

## 3. Colour palette (sampled)

**Important correction to the brief:** the game uses **two highlight systems**, not one
orange selection colour:
- **Blue = selected / equipped slot.** Inventory equipped items `#5e97cc`, build grid
  selected `#5daae0`, hotbar selected `#6b99c9`, selected build tab `#4c8dbe`.
  [obs: windowscentral-inventory-crafting.jpg, press-build-menu.png]
- **Amber = selected list row, headings, accents.** Selected recipe row `#c2812f`,
  Norse headings `#f6b863` / `#f3b867`, scrollbar `#df9d51`, list divider `#c1853f`,
  Craft label `#f3a148`, main menu hover "START GAME" `#e3972a`, menu ornament line `#c68741`.

| Role | Hex (approx) | Where |
|---|---|---|
| Wood panel dark | `#392417`-`#442d1d` | crafting description area |
| Wood panel mid | `#483221`-`#553d2c` | list bg, slot gaps |
| Wood panel light / rim | `#644631`-`#6a4b34` | header band, frame |
| Empty slot (inset) | `#4c3729` | inventory empty cell, slightly darker than gaps |
| Build board | `#302829`-`#392f31` | build menu |
| Inactive tab | `#2b2326` (build) / `#484234` (craft UPGRADE) | |
| Body text off-white | `#f1eeeb` | descriptions |
| Stat label off-white (warm) | `#e0c7c2` | "Weight:" etc |
| Stat value orange | `#d79c34` | numbers after labels |
| Stat bonus yellow | `#d9be2b` / `#f6cd17` | armour value, item title "Club" |
| Tab count yellow | `#f7f30a` | "[73]" |
| Key chip | `#999597` bg, `#f6f5f5` text | "Mouse-1", "L-Shift" |
| Menu item unselected | `#c8c9c8` | SETTINGS, CREDITS |
| Center message gold | `#ecc212` | "THE FOREST IS MOVING..." |
| Floating title amber | `#efb46c` | "Repair", "Ready" |
| Player nameplate | `#ffbb58` | other players' names |
| Health red (fill) | `#d73b3e` highlight / `#982425` body / `#5f1410` shadow | vertical health column |
| Boss name red | `#c81616` | "EIKTHYR" |
| Boss bar fill | `#d50547` / `#a5033e` | crimson-magenta |
| Boss bar track | `#2d2e30` | dark grey |
| Stamina yellow | `#cea83e` highlight / `#8a6f1a` body | bar under character |
| Eitr purple | `#d83bbe` highlight / `#a82c91` body | bar under character (Mistlands) |
| Enemy/ally HP green | `#37c714` | nameplate bars |
| Food bar segments | brown `#b58e69`, green `#cee08c` | stacked food column |

Rested buff: shown as a **red triquetra-like icon** labelled "Rested" with a countdown in the
status row at top right [obs: progametalk-rested-hud.png]. A small red knot icon also sits
under the health bar.

Rarity: **Valheim has no rarity colour tiers.** Quality is a number (1-4) shown in stats.
The gold star with "4" on the Workbench panel is the station level, not a rarity
[obs: windowscentral-inventory-crafting.jpg]. Error red for missing materials: [src:
https://www.gamepressure.com/valheim/crafting/zae311] says missing materials are shown in red
(not observed).

## 4. Components

- **Item slots** [obs: windowscentral-inventory-crafting.jpg, press-build-menu.png]: square,
  ~64-70 px at 1080p, 6-8 px gutters, radius ~2-3 px, fill slightly darker than the board,
  no border. Stack count bottom-centre in white bold Averia with a dark shadow ("41/50").
  Hotbar index top-left in light blue-white. Durability is a thin (~3-4 px) white bar along
  the bottom. Stack/quality digit top-right in amber/yellow. Selected/equipped = whole slot
  filled light blue.
- **Tabs**: craft tabs are dark rectangular plaques (`#484234`) with uppercase Averia Bold.
  The active tab has amber text and a thin amber outline. Build tabs are flat dark chips. The
  active one is filled blue with white label and yellow count [obs: both].
- **Buttons**: the primary "Craft" button is a wide dark recessed plaque (`#3d3126`) with a
  thin lighter bevel rim and a large amber Averia Bold label [obs: craft]. Main menu items are
  plain off-white Norse caps text with no box, under a fixed thin amber rule topped by a
  small knot chevron [obs: mmos-main-menu-ea.jpg, md5gaming-main-menu-mistlands.jpg]. The
  selected item turns orange and gains small chevron ornaments on either side
  [obs: md5gaming-main-menu-mistlands.jpg].
- **List rows** (recipes): icon + bold Averia label. Craftable rows are bright, uncraftable
  ones dimmed grey. The selected row is a solid amber bar with dark-on-amber text
  [obs: craft].
- **HUD health**: a **vertical** red column bottom-left with a big white number centred,
  segmented by regular short dark horizontal tick marks. A thin vertical food column
  to its left is made of stacked coloured segments. Food icons with "13m" timers sit beside it
  [obs: eurogamer-eikthyr-boss-bar.jpg, press-build-menu.png].
- **Stamina / eitr**: horizontal bars centred below the character, each ~170 px wide x 14 px
  tall, also tick-segmented, number centred, grey track [obs: press-hud-mountain.png,
  steam-combat-hud.jpg].
- **Boss bar**: Norse red caps name centred top, a wide thin (~14 px) crimson bar on a dark
  track below it [obs: eurogamer-eikthyr-boss-bar.jpg].
- **Forsaken power**: boss name above, icon tile, "Ready" or a countdown in amber below
  [obs: press-build-menu.png].
- **Status effects**: icons top-right, left of the minimap. White label above (e.g. "Megingjord",
  "Wisplight", "Rested"), timer or value below in amber [obs: steam-combat-hud.jpg,
  progametalk-rested-hud.png].
- **Minimap**: square, top-right, parchment map, biome name in white Averia top-right inside.
- **Top-left message feed**: small item icon + "Added Resin" line under the hotbar
  [obs: progametalk-rested-hud.png].
- **Center-screen messages**: large Norse caps in gold `#ecc212` with a soft dark drop
  shadow and no box, sitting directly over the world [obs: hermitgamer-forest-is-moving.png].
  Floating interaction titles ("Repair", "Wood wall 45 deg") use amber Averia Bold over a
  faint dark translucent box [obs: steam-build-placement.jpg].
- **Chat / console / settings sliders / death message / "You feel rested" toast**: **not observed** [unverified].

## 5. Iconography and runes

- Game icons are painted, semi-realistic item renders, not line icons. The panel ornaments
  (knotwork, carved header flourishes) and HUD knot icons are hand-drawn assets.
- Logo: carved metal/stone letterforms with ember glow, distinctive V and underline swash.
  **Trademark + copyright. Do not imitate closely.**
- Free to use: **Elder Futhark letters** (historical script, public domain; the Noto Sans
  Runic glyphs are OFL); generic Norse motifs you draw yourself (a triquetra, a plain
  valknut-like triangle knot, simple interlace borders); colours; layout proportions.

## 6. Motion and sound

Nothing here was observable from stills. **All [unverified]**:
- Inventory and crafting panels open and close almost instantly, with no slide.
- Center messages and boss names fade in, hold a few seconds, then fade out.
- Hover is a colour change (text to amber, slot highlight). There is no scale or glow animation.
- Hover/click play short wooden "tock" UI sounds. Do not ship game audio; if sound is wanted,
  record your own or use CC0 wood-knock samples.

Recommended for web: 120-180 ms opacity/colour transitions only; center messages
`opacity 0 -> 1` over 400 ms, hold, then out over 800 ms; respect `prefers-reduced-motion`.

## 7. Recommendations for skald (React + Tailwind)

**Tokens** (CSS variables; map them into `tailwind.config` `theme.extend.colors`):

```css
:root {
  --vh-board-900: #2a1c12;  /* deepest wood shadow */
  --vh-board-800: #3a2618;  /* panel fill */
  --vh-board-700: #4a3322;  /* list / slot gaps */
  --vh-board-600: #644631;  /* rim, header band */
  --vh-slot:      #34241a;  /* inset slot */
  --vh-stone-800: #302829;  /* alt dark board (build-menu flavour) */
  --vh-text:      #f1eeeb;  /* body */
  --vh-text-warm: #e0c7c2;  /* labels */
  --vh-text-dim:  #9a8f86;  /* disabled */
  --vh-amber:     #f3b867;  /* headings, active tab text */
  --vh-amber-600: #c2812f;  /* selected row fill */
  --vh-ember:     #fcae08;  /* separator rule core */
  --vh-gold:      #ecc212;  /* center message */
  --vh-select:    #5e97cc;  /* selected slot (blue) */
  --vh-hp:        #c8303a;  --vh-hp-hi: #d73b3e;  --vh-hp-lo: #5f1410;
  --vh-stamina:   #cea83e;  --vh-eitr: #b83ca0;
  --vh-boss:      #c81616;  --vh-boss-bar: #c3044a;  --vh-track: #2d2e30;
  --vh-ok:        #37c714;
  --vh-key:       #999597;
}
```

**Panel recipe** (opaque wood board, procedural texture, no game bitmap):

```css
.vh-panel {
  background-color: var(--vh-board-800);
  background-image:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.012 0.35' numOctaves='3' seed='7'/%3E%3CfeColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.35 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E"),
    linear-gradient(180deg, rgba(255,220,170,.06), rgba(0,0,0,.18));
  border: 1px solid #1c120b;
  box-shadow:
    inset 0 0 0 1px rgba(255,200,140,.10),  /* lighter carved rim */
    inset 0 0 24px rgba(0,0,0,.45),         /* vignette into the grain */
    0 6px 18px rgba(0,0,0,.55);
  border-radius: 3px;
}
```
The anisotropic `baseFrequency` (low x, high y) makes horizontal grain streaks, like planks.
For the ragged edge, optionally add `clip-path: polygon(...)` with 1-3 px jitter at each
corner, or an SVG `feDisplacementMap` mask. Keep it subtle.

Tailwind note: classes below use `bg-[var(--x)]`, which works in v3 and v4 (the `bg-[--x]`
shorthand is v3-only; v4 uses `bg-(--x)`).

**Slot**: `w-16 h-16 rounded-[3px] bg-[var(--vh-slot)] shadow-[inset_0_2px_6px_rgba(0,0,0,.6)]`.
Selected: `bg-[var(--vh-select)]`. Count bottom-centre with `text-shadow: 0 1px 2px #000`.
A durability-style progress line is a 3 px bar at the bottom.

**Tab**: inactive `bg-black/30 text-[var(--vh-text-warm)] uppercase font-bold`. Active adds
`text-[var(--vh-amber)] ring-1 ring-[var(--vh-amber)]/70`. Put an amber 2 px rule under the strip
(`border-b-2 border-[var(--vh-ember)]/80`).

**Button**: primary = recessed dark plaque, `bg-[#2a2018] border border-[#6b5745]/60
shadow-[inset_0_2px_8px_rgba(0,0,0,.7)]` with a large amber Averia Bold label. Hover lifts the
label to `--vh-gold` (colour only). Menu-style nav links: plain display caps, hover turns
amber and shows two small SVG flourishes (draw your own chevron/knot, not the game's).

**List row**: selected = `bg-[var(--vh-amber-600)] text-[#1d120a]`. Disabled = `text-[var(--vh-text-dim)]`.

**Resource meters** (CPU/RAM/players as health/stamina): track `--vh-track`. Fill is a
vertical gradient (`hi` to base to `lo`) with tick segmentation via
`background-image: repeating-linear-gradient(90deg, transparent 0 calc(25% - 1px), rgba(0,0,0,.55) calc(25% - 1px) 25%)`.
Put the number centred in bold white with a dark shadow. Map colours: red = health/critical,
yellow = stamina/load, purple = eitr/special. A vertical health-column variant suits a
primary metric.

**Boss-progress strip (trophies)**: a row of square slots, one per boss. Defeated = filled
slot with your own silhouette icon (SVG you draw, or a Futhark letter in Noto Sans Runic) in
`--vh-amber`. Undefeated = dim inset slot at 40% opacity. Name below in display caps, small.
The current boss gets a thin crimson bar (`--vh-boss-bar` on `--vh-track`) under its name,
like the in-game boss bar. Do not use the game's trophy renders.

**Join code as a center-screen message**: display caps, `font-size: clamp(2rem, 6vw, 4rem)`,
`color: var(--vh-gold)`, `letter-spacing: .06em`,
`text-shadow: 0 2px 0 rgba(0,0,0,.6), 0 0 18px rgba(0,0,0,.6)`, no box. Fade in on load. A
"copy" key chip sits beside it.

**Key-hint chips**: `bg-[var(--vh-key)] text-white px-1.5 rounded-[2px] font-bold` + label in
`--vh-text` (matches "Mouse-1 Place").

**Background**: dark, warm, firelit gradient behind the panels (e.g. radial ember glow
`#3a1d0c` near the bottom fading to `#0e0b09`). That evokes the menu campfire without using
the menu art.

## 8. Do NOT copy

| Item | Why |
|---|---|
| Valheim logo, wordmark, "V" swash | Trademark + copyright |
| Panel wood textures, slot/frame sprites, knotwork header ornaments, triquetra HUD icon as drawn | Game art (copyright) |
| Item, trophy, status-effect, boss icons; minimap art; screenshots as backgrounds | Game art |
| UI sounds, music | Copyright |
| Norse font files | Unless the licence is confirmed (section 1) |

Coffee Stain EULA (https://valheim.com/eula/): s.4.1.2 allows sharing gameplay screenshots and
videos. s.5.2.4 forbids "public or commercial use of any Game assets without our prior written
consent". s.11.1 says all IP belongs to Coffee Stain and its licensors. The press kit page
(https://valheim.com/press/) states no asset-usage terms ("All Rights Reserved").
Iron Gate asks fan works to state they are unofficial (https://massivelyop.com/?p=442248).
Put a footer line on the dashboard: "Not affiliated with Iron Gate or Coffee Stain."

Safe to use: palette values, layout proportions, Averia Serif/Sans Libre (OFL), Noto Sans
Runic (OFL), Elder Futhark letters, self-drawn generic Norse motifs, procedural textures.

## 9. Reference screenshots (local only, not in repo)

Reference screenshots were kept locally and are not part of this repository.

| File | Shows | Source |
|---|---|---|
| windowscentral-inventory-crafting.jpg | Inventory grid, character header, Workbench crafting panel, Craft button | https://www.windowscentral.com/valheim-workbench-guide-how-build-upgrade-and-use-repairs (cdn.mos.cms.futurecdn.net/uMZMECSguqnZKSZSbPn9rd.jpg) |
| press-build-menu.png | Build menu, tabs, hotbar, health column, key chips, minimap, status icons | https://valheim.com/press/ (a.storyblok.com/f/157036/1920x1080/ac316c9018/6-buildinggui.png) |
| press-hud-mountain.png | Stamina bar, nameplates, enemy bar | https://a.storyblok.com/f/157036/1920x1080/407622a12f/3-mountainfight.png |
| press-hud-forest.png | Minimal HUD, hotbar over sky | https://a.storyblok.com/f/157036/1920x1080/cb5e84b647/valheim2.png |
| steam-build-placement.jpg | Floating placement title and cost box | https://store.steampowered.com/app/892970/ (https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/892970/ss_f6cbfeea728d557fa9f483685fea3205f08f5d9e.1920x1080.jpg) |
| steam-combat-hud.jpg | Eitr bar, Wisplight status, nameplates | https://store.steampowered.com/app/892970/ (https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/892970/ss_0c218f8040f1d7850baff4ff4e3109942388ac98.1920x1080.jpg) |
| eurogamer-eikthyr-boss-bar.jpg | Boss name + bar, food column, health ticks | https://assetsio.gnwcdn.com/valheim_boss_fight_eikythr_move_3.jpg |
| hermitgamer-forest-is-moving.png | Center-screen raid message | https://www.hermitgamer.com/storage/attachments/images/valheim-the-forest-is-moving.webp |
| progametalk-rested-hud.png | Rested status icon + timer, top-left message feed | https://progametalk.com/wp-content/uploads/2021/03/VALTEB029-5.png |
| md5gaming-main-menu-mistlands.jpg | Main menu (v0.214.2), selected item ornaments | https://www.md5gaming.com/wp-content/uploads/2023/03/Valheim-1.jpg |
| mmos-main-menu-ea.jpg | Early Access main menu + changelog panel | https://mmos.com/wp-content/gallery/valheim/valheim-01-main-menu.jpg |

Not obtained: Fandom and wiki.gg images (Cloudflare challenge / blocked), so the pause menu,
settings, tooltip, chat and death-screen captures are missing.

## 10. Other sources

- Fonts in game: https://thunderstore.io/c/valheim/p/Nexus/Clock/ ,
  https://thunderstore.io/c/valheim/p/jp/Correct_Localization_JP/ ,
  https://thunderstore.io/c/valheim/p/VitByr/VBFontFix/
- Google Fonts licences: https://github.com/google/fonts (ofl/averiaseriflibre, ofl/averiasanslibre,
  ofl/notosansrunic, ofl/germaniaone, ofl/medievalsharp)
- Raid message wording: https://primagames.com/gaming/valheim-what-are-raids-and-how-to-survive-them-guide
