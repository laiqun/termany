import type { Theme } from "./types";

/**
 * Import support for CodexThemes packages (codexthemes.ai): either a bare
 * `theme.json` manifest or a single-file `.codex-theme` export
 * ({ format: "codex-theme", manifest, css, art, … }).
 *
 * A Codex theme's CSS layer targets Codex's own DOM and can't be reused, but
 * its manifest palette is a semantic token set that maps cleanly onto
 * Termany's Theme schema, and the export's embedded artwork becomes the
 * window background image.
 */

interface CodexPalette {
  canvas: string;
  surface: string;
  raised: string;
  text: string;
  muted: string;
  accent: string;
  border: string;
  focus?: string;
  success?: string;
  warning?: string;
  danger?: string;
  terminalBackground?: string;
  terminalForeground?: string;
}

interface CodexManifest {
  schemaVersion: number;
  id: string;
  displayName?: string;
  mode?: "light" | "dark";
  palette: CodexPalette;
}

interface CodexExport {
  format: "codex-theme";
  manifest: CodexManifest;
  art?: { mimeType?: string; base64?: string };
}

/** The manifest, whether `parsed` is an export wrapper or the manifest itself. */
function manifestOf(parsed: unknown): CodexManifest | null {
  const x = parsed as Partial<CodexExport> & Partial<CodexManifest>;
  const m = x?.format === "codex-theme" ? x.manifest : (x as CodexManifest);
  if (!m || typeof m.id !== "string" || typeof m.schemaVersion !== "number") return null;
  const p = m.palette;
  return p?.canvas && p?.text && p?.accent ? m : null;
}

/** True when `parsed` looks like a Codex theme rather than a Termany one. */
export function isCodexTheme(parsed: unknown): boolean {
  return manifestOf(parsed) !== null;
}

/** "#rgb"/"#rrggbb" → rgba(); anything else passes through unchanged. */
function alpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const hex = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `rgba(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}, ${a})`;
}

/** Convert a Codex theme (manifest or export) into a Termany Theme. */
export function fromCodexTheme(parsed: unknown): Theme {
  const m = manifestOf(parsed);
  if (!m) throw new Error("not a Codex theme");
  const p = m.palette;
  const dark = m.mode === "dark";
  const art = (parsed as Partial<CodexExport>).format === "codex-theme" ? (parsed as CodexExport).art : undefined;
  const image = art?.base64 ? `data:${art.mimeType ?? "image/jpeg"};base64,${art.base64}` : undefined;

  return {
    // Stable "custom-" id: re-importing the same theme updates it in place,
    // and the prefix makes registerTheme() persist it (see themes/index.ts).
    id: `custom-codex-${m.id}`,
    name: m.displayName ?? m.id,
    appearance: dark ? "dark" : "light",
    colors: {
      bg: p.terminalBackground ?? p.raised,
      bg2: p.canvas,
      bg3: p.surface,
      border: p.border,
      fg: p.text,
      fgDim: p.muted,
      accent: p.accent,
      accentSoft: alpha(p.accent, 0.14),
    },
    radius: dark ? { sm: "6px", md: "8px", lg: "12px" } : { sm: "8px", md: "10px", lg: "14px" },
    sidebar: { bg: p.canvas },
    chrome: {
      activeTab: p.raised,
      activeRow: alpha(p.accent, 0.12),
      // Match the Codex desktop app these themes were authored for: terminals
      // fill flush, edge-to-edge — no card gap, no rounding, no shadow. With
      // artwork the veil then covers the whole pane area seamlessly.
      paneGap: "0px",
      paneRadius: "0px",
      paneBorder: "transparent",
      paneShadow: "none",
    },
    // Codex themes are art-forward — keep the chrome (sidebar, top bar, pane
    // gaps) translucent enough that the artwork actually reads.
    background: image ? { image, opacity: 0.55 } : undefined,
    // With artwork, the terminals themselves become a translucent veil: the
    // pane card carries an rgba tint and the xterm canvas goes transparent
    // (manager.ts enables allowTransparency), so the art shows through the
    // middle of the window while text keeps a tinted backdrop for contrast.
    vars: image ? { "pane-bg": alpha(p.terminalBackground ?? p.raised, 0.55) } : undefined,
    term: {
      background: image ? alpha(p.terminalBackground ?? p.raised, 0) : (p.terminalBackground ?? p.raised),
      foreground: p.terminalForeground ?? p.text,
      cursor: p.focus ?? p.accent,
      selectionBackground: alpha(p.accent, 0.25),
      ...(p.danger ? { red: p.danger } : {}),
      ...(p.success ? { green: p.success } : {}),
      ...(p.warning ? { yellow: p.warning } : {}),
    },
  };
}
