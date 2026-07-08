import type { Theme } from "./types";

export const defaultDark: Theme = {
  id: "default-dark",
  name: "Default Dark",
  appearance: "dark",
  colors: {
    // Lifted off pure black and backed off pure white vs. the original
    // (#0e1116/#d7dce2) — same ballpark contrast for readability, less glare
    // over long sessions. Accent desaturated a touch for the same reason.
    bg: "#12151b",
    bg2: "#181d24",
    bg3: "#1f2630",
    border: "#262e39",
    fg: "#c8cdd4",
    fgDim: "#7d8794",
    accent: "#5bb8cc",
    accentSoft: "rgba(91, 184, 204, 0.16)",
  },
  radius: { sm: "6px", md: "8px", lg: "12px" },
  // A touch darker than the terminal — a distinct, recessed sidebar rail.
  sidebar: { bg: "#0e1015" },
  term: {
    background: "#12151b",
    foreground: "#c8cdd4",
    cursor: "#5bb8cc",
    selectionBackground: "#2a3441",
  },
};
