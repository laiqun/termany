import type { Theme } from "./types";

export const oneLight: Theme = {
  id: "one-light",
  name: "One Light",
  appearance: "light",
  colors: {
    bg: "#fafafa",
    bg2: "#f0f0f1",
    bg3: "#e5e5e6",
    border: "#dcdcdc",
    fg: "#383a42",
    fgDim: "#a0a1a7",
    accent: "#4078f2",
    accentSoft: "rgba(64, 120, 242, 0.14)",
  },
  // Softer, rounder corners suit the light surfaces.
  radius: { sm: "8px", md: "10px", lg: "14px" },
  // A touch grayer than the white terminal — a distinct sidebar panel.
  sidebar: { bg: "#e9ebee" },
  term: {
    background: "#fafafa",
    foreground: "#383a42",
    cursor: "#4078f2",
    selectionBackground: "#dbdbdc",
  },
};
