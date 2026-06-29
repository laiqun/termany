import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { applyTheme, loadAiThemes, loadThemeId } from "./themes";

// Register any AI-generated themes from a previous session, then paint the
// persisted theme before first render — no flash, and the first terminals are
// created with the right palette.
loadAiThemes();
applyTheme(loadThemeId());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
