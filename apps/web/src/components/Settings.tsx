import { Brain, Info, Keyboard, Palette } from "lucide-react";
import { useEffect, useState } from "react";
import { isTauri } from "../env";
import { openExternal } from "../openExternal";
import { useStore } from "../state/store";
import { checkForUpdate, installUpdate, relaunchApp } from "../updater";
import { registerTheme, THEMES } from "../themes";
import { CloseIcon } from "./icons";
import { KeyboardSettings } from "./KeyboardSettings";
import { ModelSettings } from "./ModelSettings";

type Section = "appearance" | "models" | "keyboard" | "about";

// Same host as the PTY server; the AI theme endpoint lives there (key stays
// server-side). Override with VITE_API_URL if the server moves.
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:5174";

/**
 * App-wide settings, shown as an in-app overlay (works in both web and the
 * desktop build — no separate OS window to keep in sync). Left nav + right
 * content, mirroring the familiar terminal-settings layout. MVP: Appearance.
 */
export function Settings({ onClose }: { onClose: () => void }) {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  const [section, setSection] = useState<Section>("appearance");
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState("0.1.0");
  const [aboutError, setAboutError] = useState<string | null>(null);

  // Self-update flow (desktop only): idle → checking → (none | available) →
  // downloading → restarting. `updateVersion` is global so badges stay in sync.
  const updateVersion = useStore((s) => s.updateVersion);
  const setUpdateVersion = useStore((s) => s.setUpdateVersion);
  const [updPhase, setUpdPhase] = useState<"idle" | "checking" | "none" | "downloading" | "restarting">("idle");
  const [updPct, setUpdPct] = useState(0);
  const [updError, setUpdError] = useState<string | null>(null);

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

  // Esc closes. Bubble phase (not capture) so the Keyboard section can intercept
  // Esc during a rebind — its capture-phase listener stops propagation first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function generate() {
    const brief = prompt.trim();
    if (!brief || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/theme`, {
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
            className={`settings-nav-item ${section === "appearance" ? "active" : ""}`}
            onClick={() => setSection("appearance")}
          >
            <span className="settings-nav-icon">
              <Palette size={18} />
            </span>{" "}
            Appearance
          </div>
          <div
            className={`settings-nav-item ${section === "models" ? "active" : ""}`}
            onClick={() => setSection("models")}
          >
            <span className="settings-nav-icon">
              <Brain size={18} />
            </span>{" "}
            Models
          </div>
          <div
            className={`settings-nav-item ${section === "keyboard" ? "active" : ""}`}
            onClick={() => setSection("keyboard")}
          >
            <span className="settings-nav-icon">
              <Keyboard size={18} />
            </span>{" "}
            Keyboard
          </div>
          <div
            className={`settings-nav-item ${section === "about" ? "active" : ""}`}
            onClick={() => setSection("about")}
          >
            <span className="settings-nav-icon">
              <Info size={18} />
            </span>{" "}
            About
          </div>
        </aside>

        <div className="settings-body">
          {section === "models" && <ModelSettings />}
          {section === "keyboard" && <KeyboardSettings />}
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

          <div className="settings-section-title" style={{ marginTop: 28 }}>
            THEME
          </div>
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-card ${t.id === theme ? "selected" : ""}`}
                onClick={() => setTheme(t.id)}
              >
                <span
                  className="theme-preview"
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
                </span>
                <span className="theme-card-name">{t.name}</span>
              </button>
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
    </div>
  );
}
