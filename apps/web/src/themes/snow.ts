import type { Theme } from "./types";

// A crisp, flat light theme (ChatWise-style): everything white, terminals run
// edge-to-edge with only hairline dividers — no floating cards, no shadow.
export const snow: Theme = {
  id: "snow",
  name: "Snow",
  appearance: "light",
  colors: {
    bg: "#ffffff",
    bg2: "#ffffff",
    bg3: "#f0f1f3",
    border: "#ececec",
    fg: "#2a2d31",
    fgDim: "#9a9ea4",
    accent: "#4d7cfe",
    accentSoft: "rgba(77, 124, 254, 0.12)",
  },
  radius: { sm: "6px", md: "8px", lg: "10px" },
  sidebar: { bg: "#f0f1f4", border: "#e6e7ea" },
  chrome: {
    topBar: "#ffffff",
    topBarBorder: "#ececec",
    activeTab: "#ffffff",
    activeRow: "#f0f1f3",
    // Flat: terminals fill flush, separated only by the region hairlines.
    paneGap: "0px",
    paneRadius: "0px",
    paneBorder: "transparent",
    paneShadow: "none",
  },
  term: {
    background: "#ffffff",
    foreground: "#2a2d31",
    cursor: "#2a2d31",
    selectionBackground: "#dbe6ff",
  },
};
