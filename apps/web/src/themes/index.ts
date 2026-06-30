import { applyTermTheme } from "../terminal/manager";
import { charcoal } from "./charcoal";
import { daylight } from "./daylight";
import { defaultDark } from "./default-dark";
import { meadow } from "./meadow";
import { oneLight } from "./one-light";
import { snow } from "./snow";
import { solarizedDark } from "./solarized-dark";
import type { Theme } from "./types";

export type { Theme };

/**
 * The registry. To add a theme — built-in or AI-generated — author a Theme
 * object (see ./types.ts) in its own file and append it here. Nothing else
 * needs to change: the picker, persistence, and applyTheme() are all generic.
 */
export const THEMES: Theme[] = [
  defaultDark,
  solarizedDark,
  oneLight,
  daylight,
  meadow,
  snow,
  charcoal,
];

export const DEFAULT_THEME_ID = "default-dark";
const STORAGE_KEY = "termany.theme";
const AI_THEMES_KEY = "termany.aiThemes";

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Cheap shape check for a Theme coming from the server / localStorage. */
function isTheme(t: unknown): t is Theme {
  const x = t as Theme;
  return (
    !!x &&
    typeof x.id === "string" &&
    typeof x.name === "string" &&
    (x.appearance === "dark" || x.appearance === "light") &&
    !!x.colors?.bg &&
    !!x.radius?.md &&
    !!x.term?.background
  );
}

/**
 * Add a theme to the registry at runtime (AI-generated, see Settings). Replaces
 * any existing theme with the same id. AI themes (id prefixed "ai-") are
 * persisted so they survive a reload. Returns the theme on success.
 */
export function registerTheme(theme: unknown): Theme {
  if (!isTheme(theme)) throw new Error("invalid theme");
  const i = THEMES.findIndex((t) => t.id === theme.id);
  if (i >= 0) THEMES[i] = theme;
  else THEMES.push(theme);
  persistAiThemes();
  return theme;
}

function persistAiThemes() {
  try {
    const ai = THEMES.filter((t) => t.id.startsWith("ai-"));
    localStorage.setItem(AI_THEMES_KEY, JSON.stringify(ai));
  } catch {
    /* ignore persistence failure */
  }
}

/** Load any persisted AI themes into THEMES. Call once at startup. */
export function loadAiThemes() {
  try {
    const raw = localStorage.getItem(AI_THEMES_KEY);
    if (!raw) return;
    for (const t of JSON.parse(raw)) {
      if (isTheme(t) && !THEMES.some((e) => e.id === t.id)) THEMES.push(t);
    }
  } catch {
    /* ignore */
  }
}

/** The persisted theme id, or the default when nothing's stored / unavailable. */
export function loadThemeId(): string {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    if (id && THEMES.some((t) => t.id === id)) return id;
  } catch {
    /* localStorage blocked (private mode etc.) — fall through */
  }
  return DEFAULT_THEME_ID;
}

/** Apply a theme everywhere (CSS vars + all terminals) and persist the choice. */
export function applyTheme(id: string) {
  const theme = getTheme(id);
  const root = document.documentElement;
  const { colors, radius } = theme;

  root.style.setProperty("--bg", colors.bg);
  root.style.setProperty("--bg-2", colors.bg2);
  root.style.setProperty("--bg-3", colors.bg3);
  root.style.setProperty("--border", colors.border);
  root.style.setProperty("--fg", colors.fg);
  root.style.setProperty("--fg-dim", colors.fgDim);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--accent-soft", colors.accentSoft);
  root.style.setProperty("--radius-sm", radius.sm);
  root.style.setProperty("--radius-md", radius.md);
  root.style.setProperty("--radius-lg", radius.lg);
  // A 1px border whose color is "transparent"/"none" still occupies a pixel and
  // shows what's behind it as a hairline — so collapse those to zero width.
  const borderRule = (color: string | undefined, fallback: string) => {
    const c = color ?? fallback;
    return c === "transparent" || c === "none" ? "0 solid transparent" : `1px solid ${c}`;
  };

  root.style.setProperty("--sidebar-bg", theme.sidebar?.bg ?? colors.bg2);
  root.style.setProperty("--sidebar-border", borderRule(theme.sidebar?.border, colors.border));
  root.style.setProperty("--top-bar", theme.chrome?.topBar ?? colors.bg2);
  root.style.setProperty("--top-bar-border", borderRule(theme.chrome?.topBarBorder, colors.border));
  root.style.setProperty("--active-tab", theme.chrome?.activeTab ?? colors.bg);
  root.style.setProperty("--active-row", theme.chrome?.activeRow ?? colors.bg3);
  root.style.setProperty("--pane-gap", theme.chrome?.paneGap ?? "8px");
  root.style.setProperty("--pane-radius", theme.chrome?.paneRadius ?? radius.lg);
  root.style.setProperty("--pane-border", borderRule(theme.chrome?.paneBorder, colors.border));
  root.style.setProperty(
    "--pane-shadow",
    theme.chrome?.paneShadow ?? "0 1px 3px rgba(0, 0, 0, 0.06), 0 4px 16px rgba(0, 0, 0, 0.04)"
  );
  // Escape hatch: arbitrary CSS-var overrides, applied last so they win.
  for (const [k, v] of Object.entries(theme.vars ?? {})) {
    root.style.setProperty(k.startsWith("--") ? k : `--${k}`, v);
  }
  root.dataset.appearance = theme.appearance;

  applyTermTheme(theme.term);

  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore persistence failure */
  }
}
