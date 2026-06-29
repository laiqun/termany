import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { registerTheme, THEMES } from "../themes";
import { CloseIcon } from "./icons";
import { ModelSettings } from "./ModelSettings";

type Section = "appearance" | "models";

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

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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
            <span className="settings-nav-icon">🎨</span> Appearance
          </div>
          <div
            className={`settings-nav-item ${section === "models" ? "active" : ""}`}
            onClick={() => setSection("models")}
          >
            <span className="settings-nav-icon">🧠</span> Models
          </div>
        </aside>

        <div className="settings-body">
          {section === "models" && <ModelSettings />}
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
        </div>

        <button className="settings-close" title="Close (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
