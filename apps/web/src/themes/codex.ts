import type { Theme } from "./types";

// Modeled on the ChatGPT Codex desktop app: an all-white canvas, a sidebar
// just barely off-white (not gray) with a hairline right border, and a flat,
// edge-to-edge pane layout — no card gap, no rounding, no shadow.
export const codex: Theme = {
  id: "codex",
  name: "Codex",
  appearance: "light",
  colors: {
    bg: "#ffffff",
    bg2: "#f5f5f7",
    bg3: "#ececed",
    border: "#e5e5e7",
    fg: "#1a1a1a",
    fgDim: "#5c5c62",
    accent: "#0a84ff",
    accentSoft: "rgba(10, 132, 255, 0.14)",
  },
  radius: { sm: "6px", md: "8px", lg: "10px" },
  sidebar: { bg: "#f5f5f7", border: "#e5e5e7" },
  chrome: {
    topBar: "#ffffff",
    topBarBorder: "#e5e5e7",
    activeTab: "#ffffff",
    activeRow: "#ececed",
    // Flat: terminals fill flush, edge-to-edge, no floating card.
    paneGap: "0px",
    paneRadius: "0px",
    paneBorder: "transparent",
    paneShadow: "none",
  },
  term: {
    background: "#ffffff",
    foreground: "#1a1a1a",
    cursor: "#0a84ff",
    selectionBackground: "#d6e4ff",
  },
  // The reference app has no per-pane border at all — a bright blue focus
  // ring/drag-gutter reads as loud against this otherwise borderless, flat
  // layout. The pane header's title still brightens on focus, so it's not silent.
  vars: { "--pane-focus-ring": "transparent", "--split-gutter-hover": "#c4c4c8" },
};
