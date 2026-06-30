import type { Theme } from "./types";

// A bright, airy light theme: white terminal surfaces, soft cool-gray chrome,
// a friendly blue accent, and generous rounding.
export const daylight: Theme = {
  id: "daylight",
  name: "Daylight",
  appearance: "light",
  colors: {
    bg: "#ffffff",
    bg2: "#eef1f6",
    bg3: "#e2e7ef",
    border: "#e1e6ec",
    fg: "#2b2f36",
    fgDim: "#9aa3af",
    accent: "#3b82f6",
    accentSoft: "rgba(59, 130, 246, 0.12)",
  },
  // Rounder than the dark themes for the floating, soft-card feel.
  radius: { sm: "8px", md: "10px", lg: "16px" },
  // Sidebar shares the recessed gray with the terminal frame, no hard divider.
  sidebar: { bg: "#e2e7f0", border: "transparent" },
  chrome: {
    // Soft sky-blue wash across the very top (one continuous, seamless gradient).
    topBar: "linear-gradient(105deg, #cfe6ff 0%, #eef1f6 60%)",
    topBarBorder: "transparent", // no hard line under the top strip
    // White floating active tab, faint-blue active page row.
    activeTab: "#ffffff",
    activeRow: "#dce9fb",
  },
  term: {
    background: "#ffffff",
    foreground: "#2b2f36",
    cursor: "#2b2f36",
    selectionBackground: "#cfe3ff",
  },
};
