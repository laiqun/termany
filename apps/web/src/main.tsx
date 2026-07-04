import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { isDemo } from "./demo";
import { isTauri } from "./env";
import { loadState, startStateSync, waitForServer } from "./state/sync";
import { useStore } from "./state/store";
import "./styles.css";
import { loadSnapshots, startScrollSync } from "./terminal/scroll";
import { applyTheme, loadAiThemes, loadThemeId, THEMES } from "./themes";

// In the desktop shell the window is borderless + transparent so we can draw our
// own rounded corners and traffic lights. Tag <html> so the CSS only kicks in there.
if (isTauri) document.documentElement.classList.add("tauri");

// Register any AI-generated themes from a previous session, then paint the
// persisted theme before first render — no flash, and the first terminals are
// created with the right palette.
loadAiThemes();
applyTheme(loadThemeId());

// Demo mode (the marketing site embeds this build in an iframe): the embedding
// page drives the theme — initial via `?theme=<id|system>`, live switches via
// postMessage({ type: "termany:set-theme", theme }). Ids match the site's.
if (isDemo) {
  const applyPref = (pref: unknown) => {
    if (typeof pref !== "string") return;
    // "system" isn't an app theme id — resolve it to the built-in dark/light pair.
    const id =
      pref === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "default-dark"
          : "daylight"
        : pref;
    if (THEMES.some((t) => t.id === id)) useStore.getState().setTheme(id);
  };
  applyPref(new URLSearchParams(location.search).get("theme"));
  window.addEventListener("message", (e) => {
    const d = e.data as { type?: string; theme?: string } | null;
    if (d?.type === "termany:set-theme") applyPref(d.theme);
  });
}

// Wait for the bundled server (it boots in parallel and usually loses the race),
// THEN hydrate the workspace/tab layout AND the saved terminal scrollback from
// it (SQLite) BEFORE first render, then start syncing both back. Rendering
// after means we never flash empty tabs and snapshots are ready before the first
// terminal attaches (so its restored screen is in place before the shell paints).
// If the server never answers we render anyway (degraded), but state saves stay
// disabled so the real layout in SQLite can't be clobbered by our defaults.
waitForServer().then(() =>
  Promise.allSettled([loadState(), loadSnapshots()]).finally(() => {
    startStateSync();
    startScrollSync();
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  })
);
