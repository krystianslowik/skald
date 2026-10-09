import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        coal: "#0f0b08",
        soot: "#18110c",
        wood: { DEFAULT: "#2a1d14", dark: "#1d140e", light: "#3a2a1d" },
        iron: "#5b5650",
        ember: "#ff7a1a",
        flame: "#ffb347",
        ash: "#9b8f84",
        bone: "#eadcc6",
        blood: "#c2412d",
      },
      fontFamily: {
        display: ["Cinzel", "Georgia", "serif"],
        deco: ['"Cinzel Decorative"', "Cinzel", "Georgia", "serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
} satisfies Config;
