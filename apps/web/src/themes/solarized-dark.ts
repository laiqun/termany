import type { Theme } from "./types";

export const solarizedDark: Theme = {
  id: "solarized-dark",
  name: "Solarized Dark",
  appearance: "dark",
  colors: {
    bg: "#002b36",
    bg2: "#073642",
    bg3: "#0a4250",
    border: "#0e4b59",
    fg: "#93a1a1",
    fgDim: "#586e75",
    accent: "#268bd2",
    accentSoft: "rgba(38, 139, 210, 0.18)",
  },
  // A touch tighter than Default Dark to show radius is per-theme.
  radius: { sm: "5px", md: "7px", lg: "10px" },
  term: {
    background: "#002b36",
    foreground: "#93a1a1",
    cursor: "#268bd2",
    selectionBackground: "#073642",
  },
};
