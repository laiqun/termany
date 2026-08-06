#!/usr/bin/env node
// Renders one preview image per built-in theme into docs/themes/, for the table
// in README.md. Each card is drawn from the theme's own tokens, so a theme edit
// only needs this script re-run:
//
//   node scripts/theme-previews.mjs
//
// Run it after `npm install`: it needs esbuild (a root devDependency) to read
// the theme files, and Chrome to rasterize them. ESBUILD and CHROME override
// either binary.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THEME_DIR = path.join(ROOT, "apps/web/src/themes");
const OUT_DIR = path.join(ROOT, "docs/themes");
const ESBUILD = process.env.ESBUILD ?? path.join(ROOT, "node_modules/.bin/esbuild");
const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Card size, in device pixels. Halve it for the in-app scale it imitates. */
const W = 1440;
const H = 620;
/** Width the images are stored at. Still 2x a three-column README table cell. */
const STORED_WIDTH = 800;

/** Modules in themes/ that are machinery, not themes. */
const NOT_A_THEME = new Set(["index.ts", "types.ts", "codex-import.ts", "codex-listings.ts", "codex-packs.ts"]);

/** xterm.js falls back to this palette for any ANSI slot a theme leaves unset. */
const XTERM_DEFAULTS = {
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#ffffff",
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec",
};

/** Read every theme object out of themes/*.ts, via a bundled throwaway entry. */
function readThemes(tmp) {
  const files = readdirSync(THEME_DIR).filter((f) => f.endsWith(".ts") && !NOT_A_THEME.has(f));
  const entry = path.join(tmp, "entry.ts");
  writeFileSync(
    entry,
    files.map((f, i) => `import * as m${i} from ${JSON.stringify(path.join(THEME_DIR, f))};`).join("\n") +
      `\nconst mods = [${files.map((_, i) => `m${i}`).join(", ")}];\n` +
      `const themes = mods.flatMap((m) => Object.values(m)).filter((t) => t && t.id && t.term);\n` +
      `console.log(JSON.stringify(themes));\n`,
  );
  const bundle = path.join(tmp, "themes.mjs");
  execFileSync(ESBUILD, [entry, "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`, "--log-level=error"]);
  return JSON.parse(execFileSync(process.execPath, [bundle], { encoding: "utf8" }));
}

function card(t) {
  const c = t.colors;
  const term = { ...XTERM_DEFAULTS, ...t.term };
  const topBar = t.chrome?.topBar ?? c.bg2;
  const topBarBorder = t.chrome?.topBarBorder ?? c.border;
  const activeTab = t.chrome?.activeTab ?? c.bg;
  const activeRow = t.chrome?.activeRow ?? c.bg3;
  const sideBg = t.sidebar?.bg ?? c.bg2;
  const sideBorder = t.sidebar?.border ?? c.border;
  const paneGap = t.chrome?.paneGap ?? "8px";
  const paneRadius = t.chrome?.paneRadius ?? t.radius.lg;
  const paneBorder = t.chrome?.paneBorder ?? c.border;
  const paneShadow = t.chrome?.paneShadow ?? "0 2px 10px rgba(0,0,0,0.18)";
  // The card is drawn at 2x, so every length taken from the theme doubles too.
  const x2 = (v) => String(v).replace(/(-?[\d.]+)px/g, (_, n) => `${Number(n) * 2}px`);
  const prompt = `<span style="color:${term.green}">→</span>  <span style="color:${term.cyan}">termany</span> <span style="color:${term.blue}">git:(</span><span style="color:${term.red}">main</span><span style="color:${term.blue}">)</span> <span style="color:${term.yellow}">✗</span>`;

  return `<!doctype html>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; }
  body {
    background: ${c.bg}; color: ${c.fg}; overflow: hidden;
    font: 26px/1.4 -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
    display: flex; flex-direction: column;
  }
  .top {
    height: 92px; flex: none; display: flex; align-items: center; gap: 24px;
    padding: 0 28px; background: ${topBar}; border-bottom: 2px solid ${topBarBorder};
  }
  .lights { display: flex; gap: 14px; }
  .lights i { width: 22px; height: 22px; border-radius: 50%; background: ${c.fgDim}; opacity: .5; }
  .ws { font-weight: 600; }
  .tabs { display: flex; gap: 10px; margin-left: 22px; }
  .tab { padding: 10px 26px; border-radius: ${x2(t.radius.md)}; color: ${c.fgDim}; font-size: 24px; }
  .tab.on { background: ${activeTab}; color: ${c.fg}; }
  .body { flex: 1; display: flex; min-height: 0; }
  .side {
    width: 300px; flex: none; background: ${sideBg}; border-right: 2px solid ${sideBorder};
    padding: 24px 16px; display: flex; flex-direction: column; gap: 6px;
  }
  .side h6 { font-size: 20px; letter-spacing: .12em; color: ${c.fgDim}; padding: 0 14px 14px; font-weight: 600; }
  .row {
    display: flex; align-items: center; gap: 12px; padding: 12px 14px;
    border-radius: ${x2(t.radius.md)}; color: ${c.fgDim}; font-size: 24px;
  }
  .row.on { background: ${activeRow}; color: ${c.fg}; }
  .row .dot { width: 14px; height: 14px; border-radius: 50%; background: ${c.accent}; margin-left: auto; }
  .main { flex: 1; min-width: 0; padding: ${x2(paneGap)}; background: ${c.bg}; }
  .pane {
    height: 100%; display: flex; flex-direction: column; overflow: hidden;
    background: ${term.background}; border: 2px solid ${paneBorder};
    border-radius: ${x2(paneRadius)}; box-shadow: ${x2(paneShadow)};
  }
  .head {
    height: 66px; flex: none; display: flex; align-items: center; justify-content: space-between;
    padding: 0 24px; background: ${c.bg2}; color: ${c.fgDim};
    border-bottom: 2px solid ${c.border}; font-size: 22px;
  }
  .head b { color: ${c.fg}; font-weight: 600; }
  pre {
    flex: 1; padding: 24px 26px; color: ${term.foreground}; white-space: pre;
    font: 25px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .cur { background: ${term.cursor}; color: ${term.background}; }
</style>
<div class="top">
  <span class="lights"><i></i><i></i><i></i></span>
  <span class="ws">workspace</span>
  <span class="tabs"><span class="tab on">tab 1</span><span class="tab">tab 2</span><span class="tab">tab 3</span></span>
</div>
<div class="body">
  <div class="side">
    <h6>PAGES</h6>
    <div class="row">termany</div>
    <div class="row on">agent<span class="dot"></span></div>
    <div class="row">remote_dev</div>
    <div class="row">local_dev</div>
  </div>
  <div class="main">
    <div class="pane">
      <div class="head"><b>${t.name}</b><span>${t.appearance}</span></div>
<pre>${prompt} ls
<span style="color:${term.brightBlue}">apps</span>       <span style="color:${term.brightBlue}">docs</span>       <span style="color:${term.brightBlue}">packages</span>
README.md  LICENSE    package.json

${prompt} npm test
  <span style="color:${term.green}">✓ 128 passed</span>   <span style="color:${term.yellow}">⚠ 2 skipped</span>   <span style="color:${term.magenta}">1 flaky</span>

${prompt} <span class="cur">&nbsp;</span></pre>
    </div>
  </div>
</div>`;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "termany-themes-"));
try {
  mkdirSync(OUT_DIR, { recursive: true });
  const themes = readThemes(tmp);
  for (const t of themes) {
    const html = path.join(tmp, `${t.id}.html`);
    const png = path.join(OUT_DIR, `${t.id}.png`);
    writeFileSync(html, card(t));
    execFileSync(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--screenshot=${png}`,
      `--window-size=${W},${H}`,
      html,
    ], { stdio: "ignore" });
    execFileSync("sips", ["-Z", String(STORED_WIDTH), png], { stdio: "ignore" });
    console.log(`docs/themes/${t.id}.png  ${t.name}`);
  }
  console.log(`\n${themes.length} themes rendered.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
