import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { isTauri } from "./env";
import { loadState, startStateSync } from "./state/sync";
import "./styles.css";
import { applyTheme, loadAiThemes, loadThemeId } from "./themes";

// In the desktop shell the window is borderless + transparent so we can draw our
// own rounded corners and traffic lights. Tag <html> so the CSS only kicks in there.
if (isTauri) document.documentElement.classList.add("tauri");

// Register any AI-generated themes from a previous session, then paint the
// persisted theme before first render — no flash, and the first terminals are
// created with the right palette.
loadAiThemes();
applyTheme(loadThemeId());

// Hydrate the workspace/tab layout from the server (SQLite) BEFORE first render,
// then start syncing changes back. Render after, so we never flash empty tabs.
loadState().finally(() => {
  startStateSync();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
