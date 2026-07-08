import { Bot, Brain, Download, Info, Keyboard, Palette, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiPath } from "../api";
import { isTauri } from "../env";
import { useI18n, type Language } from "../i18n";
import { openExternal } from "../openExternal";
import { useStore } from "../state/store";
import { checkForUpdate, installUpdate, relaunchApp } from "../updater";
import { registerTheme, THEMES, type Theme } from "../themes";
import { AgentSettings } from "./AgentSettings";
import { CloseIcon, EditIcon, GearIcon } from "./icons";
import { KeyboardSettings } from "./KeyboardSettings";
import { ModelSettings } from "./ModelSettings";
import { ThemeEditor } from "./ThemeEditor";

export type SettingsSection = "general" | "appearance" | "models" | "agents" | "keyboard" | "about";

/**
 * App-wide settings, shown as an in-app overlay (works in both web and the
 * desktop build — no separate OS window to keep in sync). Left nav + right
 * content, mirroring the familiar terminal-settings layout. MVP: Appearance.
 */
export function Settings({
  initialSection = "general",
  onClose,
}: {
  initialSection?: SettingsSection;
  onClose: () => void;
}) {
  const { language, setLanguage, t } = useI18n();
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [editingTheme, setEditingTheme] = useState<Theme | null>(null);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [version, setVersion] = useState("0.1.0");
  const [aboutError, setAboutError] = useState<string | null>(null);

  // Self-update flow (desktop only): idle → checking → (none | available) →
  // downloading → restarting. `updateVersion` is global so badges stay in sync.
  const updateVersion = useStore((s) => s.updateVersion);
  const setUpdateVersion = useStore((s) => s.setUpdateVersion);
  const [updPhase, setUpdPhase] = useState<"idle" | "checking" | "none" | "downloading" | "restarting">("idle");
  const [updPct, setUpdPct] = useState(0);
  const [updError, setUpdError] = useState<string | null>(null);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  async function checkUpdates() {
    setUpdPhase("checking");
    setUpdError(null);
    try {
      const u = await checkForUpdate();
      setUpdateVersion(u?.version ?? null);
      setUpdPhase(u ? "idle" : "none");
    } catch (e) {
      setUpdError(e instanceof Error ? e.message : String(e));
      setUpdPhase("idle");
    }
  }

  async function applyUpdate() {
    setUpdPhase("downloading");
    setUpdPct(0);
    setUpdError(null);
    try {
      await installUpdate(setUpdPct);
      setUpdPhase("restarting");
      await relaunchApp();
    } catch (e) {
      setUpdError(e instanceof Error ? e.message : String(e));
      setUpdPhase("idle");
    }
  }

  // The desktop app exposes the real bundle version; the browser keeps the default.
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => {});
  }, []);

  // Esc closes. Capture on `document` so the terminal/xterm cannot swallow the
  // key before this overlay sees it. Keyboard rebinding still wins because it
  // listens on `window` capture; the theme editor is allowed to handle its own
  // Esc in bubble phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editingTheme) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, editingTheme]);

  async function generate() {
    const brief = prompt.trim();
    if (!brief || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(apiPath("/api/theme"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: brief }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      const created = registerTheme(data); // adds to THEMES + persists
      setTheme(created.id); // apply it (and re-render the grid)
      setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function importThemeFile(file: File | undefined) {
    if (!file) return;
    setImportError(null);
    try {
      const parsed = JSON.parse(await file.text());
      // Re-imported exports (already "custom-"/"ai-") update in place; anything
      // else (a shared built-in, a hand-authored file) gets a fresh custom id
      // so it persists as the user's own theme instead of silently vanishing —
      // registerTheme() only persists ids with those prefixes (see themes/index.ts).
      if (typeof parsed?.id !== "string" || !/^(custom|ai)-/.test(parsed.id)) {
        parsed.id = `custom-${crypto.randomUUID()}`;
      }
      const created = registerTheme(parsed);
      setTheme(created.id);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  }

  function exportThemeFile(t: Theme) {
    const blob = new Blob([JSON.stringify(t, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${t.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-window"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="settings-nav">
          <div
            className={`settings-nav-item ${section === "general" ? "active" : ""}`}
            onClick={() => setSection("general")}
          >
            <span className="settings-nav-icon">
              <GearIcon />
            </span>{" "}
            {t("settings.general")}
          </div>
          <div
            className={`settings-nav-item ${section === "appearance" ? "active" : ""}`}
            onClick={() => setSection("appearance")}
          >
            <span className="settings-nav-icon">
              <Palette size={18} />
            </span>{" "}
            {t("settings.appearance")}
          </div>
          <div
            className={`settings-nav-item ${section === "models" ? "active" : ""}`}
            onClick={() => setSection("models")}
          >
            <span className="settings-nav-icon">
              <Brain size={18} />
            </span>{" "}
            {t("settings.models")}
          </div>
          <div
            className={`settings-nav-item ${section === "agents" ? "active" : ""}`}
            onClick={() => setSection("agents")}
          >
            <span className="settings-nav-icon">
              <Bot size={18} />
            </span>{" "}
            {t("settings.agents")}
          </div>
          <div
            className={`settings-nav-item ${section === "keyboard" ? "active" : ""}`}
            onClick={() => setSection("keyboard")}
          >
            <span className="settings-nav-icon">
              <Keyboard size={18} />
            </span>{" "}
            {t("settings.keyboard")}
          </div>
          <div
            className={`settings-nav-item ${section === "about" ? "active" : ""}`}
            onClick={() => setSection("about")}
          >
            <span className="settings-nav-icon">
              <Info size={18} />
            </span>{" "}
            {t("settings.about")}
          </div>
        </aside>

        <div className="settings-body">
          {section === "models" && <ModelSettings />}
          {section === "agents" && <AgentSettings />}
          {section === "keyboard" && <KeyboardSettings />}
          {section === "general" && (
            <>
              <div className="settings-section-title">{t("settings.language.title")}</div>
              <label className="language-setting">
                <span>{t("settings.language.label")}</span>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as Language)}
                >
                  <option value="en">{t("settings.language.en")}</option>
                  <option value="zh-CN">{t("settings.language.zh")}</option>
                </select>
              </label>
            </>
          )}
          {section === "appearance" && (
          <>
          <div className="settings-section-title">GENERATE WITH AI</div>
          <div className="ai-theme">
            <input
              className="ai-theme-input"
              placeholder="Describe a theme — e.g. cyberpunk purple, rounded"
              value={prompt}
              disabled={generating}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return; // let the IME handle Enter
                if (e.key === "Enter") generate();
              }}
            />
            <button
              className="ai-theme-btn"
              onClick={generate}
              disabled={generating || !prompt.trim()}
            >
              {generating ? "Generating…" : "Generate"}
            </button>
          </div>
          {error && <div className="ai-theme-error">{error}</div>}

          <div
            className="settings-section-title"
            style={{ marginTop: 28, display: "flex", alignItems: "center", justifyContent: "space-between" }}
          >
            THEME
            <button
              className="ws-dialog-btn"
              title="Import a theme JSON file"
              onClick={() => importInputRef.current?.click()}
            >
              <Upload size={13} /> Import
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                void importThemeFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
          {importError && <div className="ai-theme-error">{importError}</div>}
          <div className="theme-grid">
            {THEMES.map((t) => (
              <div key={t.id} className={`theme-card ${t.id === theme ? "selected" : ""}`}>
                <div className="theme-preview-wrap">
                  <button
                    className="theme-preview"
                    onClick={() => setTheme(t.id)}
                    style={{
                      background: t.term.background as string,
                      borderColor: t.colors.border,
                      borderRadius: t.radius.lg,
                    }}
                  >
                    <span className="theme-preview-side" style={{ background: t.colors.bg2 }} />
                    <span className="theme-preview-dot" style={{ background: t.colors.accent }} />
                    <span className="theme-preview-line lg" style={{ background: t.colors.fg }} />
                    <span className="theme-preview-line" style={{ background: t.colors.fgDim }} />
                    <span className="theme-preview-line sm" style={{ background: t.colors.fgDim }} />
                  </button>
                  <button className="theme-edit-btn" title="Edit theme" onClick={() => setEditingTheme(t)}>
                    <EditIcon />
                  </button>
                  <button
                    className="theme-edit-btn theme-export-btn"
                    title="Export theme as JSON"
                    onClick={() => exportThemeFile(t)}
                  >
                    <Download size={13} />
                  </button>
                </div>
                <span className="theme-card-name">{t.name}</span>
              </div>
            ))}
          </div>
          </>
          )}
          {section === "about" && (
            <>
              <div className="settings-section-title">ABOUT</div>
              <div className="about">
                <div className="about-name">Termany</div>
                <div className="about-version">Version {version}</div>
                {isTauri && (
                  <div className="about-update">
                    {updateVersion ? (
                      updPhase === "downloading" ? (
                        <div className="update-progress">
                          <div className="update-progress-track">
                            <div className="update-progress-fill" style={{ width: `${updPct}%` }} />
                          </div>
                          <span>Downloading… {updPct}%</span>
                        </div>
                      ) : updPhase === "restarting" ? (
                        <span className="update-status">Installed — restarting…</span>
                      ) : (
                        <button className="update-btn" onClick={applyUpdate}>
                          Update to v{updateVersion} &amp; restart
                        </button>
                      )
                    ) : (
                      <button
                        className="update-check-btn"
                        onClick={checkUpdates}
                        disabled={updPhase === "checking"}
                      >
                        {updPhase === "checking"
                          ? "Checking…"
                          : updPhase === "none"
                            ? "You're up to date ✓"
                            : "Check for updates"}
                      </button>
                    )}
                    {updError && <div className="ai-theme-error">update failed: {updError}</div>}
                  </div>
                )}
                <p className="about-desc">An agent-native terminal — local-first, cloud-ready.</p>
                <div className="about-author">
                  Website{" "}
                  <button
                    className="about-link"
                    onClick={async () => setAboutError(await openExternal("https://termany.sh"))}
                  >
                    termany.sh
                  </button>
                </div>
                <div className="about-author">
                  Made by{" "}
                  <button
                    className="about-link"
                    onClick={async () => setAboutError(await openExternal("https://idoubi.ai"))}
                  >
                    idoubi
                  </button>
                </div>
                {aboutError && <div className="ai-theme-error">opener failed: {aboutError}</div>}
              </div>
            </>
          )}
        </div>

        <button className="settings-close" title="Close (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      {editingTheme && (
        <ThemeEditor base={editingTheme} activeThemeId={theme} onClose={() => setEditingTheme(null)} />
      )}
    </div>
  );
}
