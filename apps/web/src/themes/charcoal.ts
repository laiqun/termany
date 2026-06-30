import type { Theme } from "./types";

// A unified warm-dark theme: sidebar, top bar, and terminals all share ONE
// charcoal background. Flat and flush — structure comes from faint hairlines
// and a slightly lighter rounded highlight on the active tab/row.
export const charcoal: Theme = {
  id: "charcoal",
  name: "Charcoal",
  appearance: "dark",
  colors: {
    bg: "#2a2826",
    bg2: "#2a2826", // same as bg — unified surface
    bg3: "#3a3834", // hover / active highlight
    border: "#363430", // faint divider, just above the bg
    fg: "#d8d4ca",
    fgDim: "#8d887e",
    accent: "#d8a657", // warm amber
    accentSoft: "rgba(216, 166, 87, 0.14)",
  },
  radius: { sm: "6px", md: "8px", lg: "8px" },
  // Whole sidebar one color, faint right divider.
  sidebar: { bg: "#222120", border: "#33312d" },
  chrome: {
    topBar: "#2a2826",
    topBarBorder: "#363430",
    activeTab: "#3a3834",
    activeRow: "#3a3834",
    // Flat: terminals fill flush, only hairline split dividers.
    paneGap: "0",
    paneRadius: "0",
    paneBorder: "transparent",
    paneShadow: "none",
  },
  term: {
    background: "#2a2826",
    foreground: "#d8d4ca",
    cursor: "#e8dcc0",
    selectionBackground: "#413d36",
  },
};
