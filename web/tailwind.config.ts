import type { Config } from "tailwindcss";

// Colour names kept from the first theme; values follow the Valheim palette in
// docs/design/valheim-ui-research.md (section 7).
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        coal: "#0e0b09",
        soot: "#1e140d",
        wood: { DEFAULT: "#3a2618", dark: "#2a1c12", light: "#4a3322", rim: "#644631" },
        slot: "#2e1f15",
        iron: "#6b5745",
        ember: "#c2812f",
        flame: "#f3b867",
        gold: "#ecc212",
        ash: "#b3a596",
        label: "#e0c7c2",
        bone: "#f1eeeb",
        blood: "#e86a5a",
        hp: "#c8303a",
        stamina: "#cea83e",
        eitr: "#b83ca0",
        boss: "#e2453f",
        select: { DEFAULT: "#5e97cc", hi: "#8cbce6" },
      },
      fontFamily: {
        display: ['"Averia Serif Libre"', "Georgia", "serif"],
        sans: ['"Averia Serif Libre"', "Georgia", "serif"],
        rune: ['"Noto Sans Runic"', "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
} satisfies Config;
