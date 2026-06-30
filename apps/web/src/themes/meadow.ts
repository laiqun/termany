import type { Theme } from "./types";

// A calm light theme with green accents — same floating-card layout as Daylight
// but a flat top bar, soft-green selections, and a green cursor. Shows how the
// chrome tokens let two light themes look distinct.
export const meadow: Theme = {
  id: "meadow",
  name: "Meadow",
  appearance: "light",
  colors: {
    bg: "#ffffff",
    bg2: "#f2f4f2",
    bg3: "#e6ebe6",
    border: "#e2e7e2",
    fg: "#2f3a33",
    fgDim: "#97a39b",
    accent: "#3f9d5a",
    accentSoft: "rgba(63, 157, 90, 0.14)",
  },
  radius: { sm: "8px", md: "10px", lg: "16px" },
  sidebar: { bg: "#e6ebe6", border: "transparent" },
  chrome: {
    topBar: "#f2f4f2", // flat, no gradient
    activeTab: "#d8ecdb", // soft green
    activeRow: "#d8ecdb",
  },
  term: {
    background: "#ffffff",
    foreground: "#2f3a33",
    cursor: "#3f9d5a",
    selectionBackground: "#cfe8d4",
  },
};
