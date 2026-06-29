import type { Theme } from "./types";

export const defaultDark: Theme = {
  id: "default-dark",
  name: "Default Dark",
  appearance: "dark",
  colors: {
    bg: "#0e1116",
    bg2: "#151a21",
    bg3: "#1c232c",
    border: "#232b35",
    fg: "#d7dce2",
    fgDim: "#7d8794",
    accent: "#5ccfe6",
    accentSoft: "rgba(92, 207, 230, 0.16)",
  },
  radius: { sm: "6px", md: "8px", lg: "12px" },
  term: {
    background: "#0e1116",
    foreground: "#d7dce2",
    cursor: "#5ccfe6",
    selectionBackground: "#2a3441",
  },
};
