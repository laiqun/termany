import { Bot, Brain, Info, Keyboard, Palette } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { apiPath } from "../api";
import { isTauri } from "../env";
import { useI18n, type Language } from "../i18n";
import { openExternal, revealPath } from "../openExternal";
import { useStore } from "../state/store";
import { checkForUpdate, installUpdate, relaunchApp } from "../updater";
import { BUILT_IN_THEMES } from "../themes";
import {
  codexThemeId,
  fetchCodexListings,
  registerCodexListing,
  type CodexListing,
} from "../themes/codex-packs";
import {
  loadFontConfig,
  saveFontConfig,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  DEFAULT_FONT_CONFIG,
  type FontConfig,
} from "../font-config";
import { applyFontFamily, applyFontSize } from "../terminal/manager";
import { AgentSettings } from "./AgentSettings";
import { CloseIcon, ExternalOpenIcon, GearIcon, RevealFolderIcon } from "./icons";
import { KeyboardSettings } from "./KeyboardSettings";
import { ModelSettings } from "./ModelSettings";
import { UsageSelect } from "./Select";

/** Where users get more custom themes (the folder below is populated from it). */
const THEMES_SITE = "https://codexthemes.ai/themes";
const THEMES_SITE_LABEL = "codexthemes.ai/themes";

const REPO = "https://github.com/thinkany-ai/termany";

/** About-section destinations; `key` also names the i18n label (about.<key>). */
const ABOUT_LINKS = [
  { key: "website", url: "https://termany.sh?utm_source=termany_app&utm_medium=settings_about" },
  { key: "source", url: REPO },
  { key: "feedback", url: `${REPO}/issues` },
] as const;

export type SettingsSection = "general" | "appearance" | "models" | "agents" | "keyboard" | "about";

/** Left-nav entries, in display order. Labels come from i18n (settings.<id>). */
const NAV_SECTIONS: { id: SettingsSection; icon: ReactNode }[] = [
  { id: "general", icon: <GearIcon /> },
  { id: "appearance", icon: <Palette size={16} /> },
  { id: "models", icon: <Brain size={16} /> },
  { id: "agents", icon: <Bot size={16} /> },
  { id: "keyboard", icon: <Keyboard size={16} /> },
  { id: "about", icon: <Info size={16} /> },
];

/**
 * App-wide settings, shown as an in-app overlay (works in both web and the
 * desktop build — no separate OS window to keep in sync). Left nav + right
 * content, mirroring the familiar terminal-settings layout. MVP: Appearance.
 */
export function Settings({
  initialSection = "general",
  onClose,
  onSectionChange,
}: {
  initialSection?: SettingsSection;
  onClose: () => void;
  /** Reported so the panel can reopen where the user left it. */
  onSectionChange?: (section: SettingsSection) => void;
}) {
  const { language, setLanguage, t } = useI18n();
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  const [fontConfig, setFontConfig] = useState<FontConfig>(loadFontConfig);

  const [section, setSection] = useState<SettingsSection>(initialSection);

  const goto = (next: SettingsSection) => {
    setSection(next);
    onSectionChange?.(next);
  };
  const [importError, setImportError] = useState<string | null>(null);
  const [codexThemes, setCodexThemes] = useState<CodexListing[]>([]);
  // Absolute path of ~/.codexthemes/themes, reported by the server so the
  // reveal button doesn't have to guess the home directory.
  const [themesRoot, setThemesRoot] = useState<string | null>(null);
  const [applyingCodex, setApplyingCodex] = useState<string | null>(null);
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
  // listens on `window` capture.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // The gallery of locally installed CodexThemes packages (~/.codexthemes),
  // refetched each time Appearance opens so newly created packages show up.
  useEffect(() => {
    if (section !== "appearance") return;
    fetchCodexListings()
      .then(({ themes, root }) => {
        setCodexThemes(themes);
        setThemesRoot(root);
      })
      .catch(() => setCodexThemes([]));
  }, [section]);

  /** One-click apply. The theme is registered in memory only — the folder on
   *  disk stays the source of truth and is re-read on the next launch. */
  async function applyCodexTheme(item: CodexListing) {
    setImportError(null);
    setApplyingCodex(item.manifest.id);
    try {
      const created = await registerCodexListing(item);
      setTheme(created.id);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyingCodex(null);
    }
  }

  /** Open ~/.codexthemes/themes in Finder/Explorer (desktop only). */
  async function revealThemesFolder() {
    if (!themesRoot) return;
    setImportError(await revealPath(themesRoot));
  }


  // The empty-state sentence wraps a link, so it's split on the {site}
  // placeholder instead of concatenated — each language keeps its own word
  // order and spacing around the link.
  const [emptyBefore, emptyAfter] = t("theme.empty").split("{site}");

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-window"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="settings-nav">
          <div className="settings-nav-title">{t("settings.title")}</div>
          {NAV_SECTIONS.map(({ id, icon }) => (
            <div
              key={id}
              className={`settings-nav-item ${section === id ? "active" : ""}`}
              onClick={() => goto(id)}
            >
              <span className="settings-nav-icon">{icon}</span>
              {t(`settings.${id}`)}
            </div>
          ))}
        </aside>

        <div className="settings-body">
          {section === "models" && <ModelSettings />}
          {section === "agents" && <AgentSettings />}
          {section === "keyboard" && <KeyboardSettings />}
          {section === "general" && (
            <>
              <div className="settings-section-title">{t("settings.language.title")}</div>
              <div className="language-setting">
                <span>{t("settings.language.label")}</span>
                {/* Custom select — the native popup can't be themed and looks
                    out of place in the desktop (WKWebView) build. */}
                <UsageSelect
                  value={language}
                  width={200}
                  options={[
                    { value: "en", label: t("settings.language.en") },
                    { value: "zh-CN", label: t("settings.language.zh") },
                  ]}
                  onChange={(v) => setLanguage(v as Language)}
                />
              </div>
            </>
          )}
          {section === "appearance" && (
          <>
          <div className="settings-section-title">{t("theme.title")}</div>
          <div className="theme-grid">
            {BUILT_IN_THEMES.map((item) => (
              <div key={item.id} className={`theme-card ${item.id === theme ? "selected" : ""}`}>
                <div className="theme-preview-wrap">
                  <button
                    className="theme-preview"
                    onClick={() => setTheme(item.id)}
                    style={{
                      background: item.term.background as string,
                      borderColor: item.colors.border,
                      borderRadius: item.radius.lg,
                    }}
                  >
                    <span className="theme-preview-side" style={{ background: item.colors.bg2 }} />
                    <span className="theme-preview-dot" style={{ background: item.colors.accent }} />
                    <span className="theme-preview-line lg" style={{ background: item.colors.fg }} />
                    <span className="theme-preview-line" style={{ background: item.colors.fgDim }} />
                    <span className="theme-preview-line sm" style={{ background: item.colors.fgDim }} />
                  </button>
                </div>
                <span className="theme-card-name">{item.name}</span>
              </div>
            ))}
          </div>

          <div className="settings-section-title custom-themes-head">
            <span>
              {t("theme.custom")} <span className="codex-themes-hint">~/.codexthemes</span>
            </span>
            <span className="custom-themes-actions">
              <button
                className="ws-dialog-btn"
                title={t("theme.openFolder")}
                onClick={() => void revealThemesFolder()}
              >
                <RevealFolderIcon />
              </button>
              <button
                className="ws-dialog-btn"
                title={THEMES_SITE}
                onClick={() => void openExternal(THEMES_SITE)}
              >
                <ExternalOpenIcon /> {t("theme.browse")}
              </button>
            </span>
          </div>
          {importError && <div className="ai-theme-error">{importError}</div>}
          {codexThemes.length === 0 ? (
            <div className="custom-themes-empty">
              {emptyBefore}
              <button className="link-btn" onClick={() => void openExternal(THEMES_SITE)}>
                {THEMES_SITE_LABEL}
              </button>
              {emptyAfter}
            </div>
          ) : (
            <>
              <div className="codex-theme-grid">
                {codexThemes.map((item) => {
                  const active = theme === codexThemeId(item.manifest.id);
                  const shot = item.previewPath ?? item.artPath;
                  return (
                    <button
                      key={item.manifest.id}
                      type="button"
                      className={`codex-theme-card ${active ? "selected" : ""}`}
                      disabled={applyingCodex !== null}
                      onClick={() => void applyCodexTheme(item)}
                    >
                      {shot && (
                        <img
                          className="codex-theme-shot"
                          src={apiPath(`/api/fs/media?path=${encodeURIComponent(shot)}`)}
                          alt=""
                          loading="lazy"
                        />
                      )}
                      <div className="codex-theme-body">
                        <div className="codex-theme-title">
                          <span className="codex-theme-name">{item.manifest.displayName ?? item.manifest.id}</span>
                          <span className="codex-theme-mode">
                            {t(item.manifest.mode === "dark" ? "theme.mode.dark" : "theme.mode.light")}
                          </span>
                        </div>
                        {item.manifest.description && (
                          <div className="codex-theme-desc">{item.manifest.description}</div>
                        )}
                        {(active || applyingCodex === item.manifest.id) && (
                          <div className="codex-theme-actions">
                            <span className="codex-theme-active">
                              {t(applyingCodex === item.manifest.id ? "theme.applying" : "theme.active")}
                            </span>
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <div className="settings-section-title">{t("font.title")}</div>

          <div className="font-setting">
            <span>{t("font.family")}</span>
            <input
              className="font-family-input"
              type="text"
              spellCheck={false}
              placeholder='Menlo, "SF Mono", Monaco, monospace'
              value={fontConfig.family}
              onChange={(e) => {
                const next = { ...fontConfig, family: e.target.value };
                setFontConfig(next);
              }}
              onBlur={(e) => {
                const family = e.target.value.trim() || DEFAULT_FONT_CONFIG.family;
                const next = { ...fontConfig, family };
                setFontConfig(next);
                saveFontConfig(next);
                applyFontFamily(family);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          </div>

          <div className="font-setting">
            <span>{t("font.size")}</span>
            <div className="font-size-control">
              <button
                className="font-size-btn"
                disabled={fontConfig.size <= MIN_FONT_SIZE}
                onClick={() => {
                  const next = { ...fontConfig, size: fontConfig.size - 1 };
                  setFontConfig(next);
                  saveFontConfig(next);
                  applyFontSize(next.size);
                }}
              >
                −
              </button>
              <span className="font-size-value">{fontConfig.size}px</span>
              <button
                className="font-size-btn"
                disabled={fontConfig.size >= MAX_FONT_SIZE}
                onClick={() => {
                  const next = { ...fontConfig, size: fontConfig.size + 1 };
                  setFontConfig(next);
                  saveFontConfig(next);
                  applyFontSize(next.size);
                }}
              >
                +
              </button>
              <button
                className="font-size-reset"
                disabled={fontConfig.size === DEFAULT_FONT_CONFIG.size}
                onClick={() => {
                  const next = { ...fontConfig, size: DEFAULT_FONT_CONFIG.size };
                  setFontConfig(next);
                  saveFontConfig(next);
                  applyFontSize(next.size);
                }}
              >
                {t("font.reset")}
              </button>
            </div>
          </div>
          </>
          )}
          {section === "about" && (
            <>
              <div className="settings-section-title">{t("about.title")}</div>
              <div className="about">
                <div className="about-hero">
                  <img className="about-logo" src="/favicon.png" alt="" />
                  <div className="about-hero-meta">
                    <div className="about-name">Termany</div>
                    <div className="about-version">
                      {t("about.version")} {version}
                    </div>
                  </div>
                </div>
                {isTauri && (
                  <div className="about-update">
                    {updateVersion ? (
                      updPhase === "downloading" ? (
                        <div className="update-progress">
                          <div className="update-progress-track">
                            <div className="update-progress-fill" style={{ width: `${updPct}%` }} />
                          </div>
                          <span>
                            {t("about.downloading")} {updPct}%
                          </span>
                        </div>
                      ) : updPhase === "restarting" ? (
                        <span className="update-status">{t("about.restarting")}</span>
                      ) : (
                        <button className="update-btn" onClick={applyUpdate}>
                          {t("about.updateRestart", { version: updateVersion })}
                        </button>
                      )
                    ) : (
                      <button
                        className="update-check-btn"
                        onClick={checkUpdates}
                        disabled={updPhase === "checking"}
                      >
                        {updPhase === "checking"
                          ? t("about.checking")
                          : updPhase === "none"
                            ? t("about.upToDate")
                            : t("about.checkUpdates")}
                      </button>
                    )}
                    {updError && (
                      <div className="ai-theme-error">
                        {t("about.updateFailed")}: {updError}
                      </div>
                    )}
                  </div>
                )}
                <p className="about-desc">{t("about.desc")}</p>
                <div className="about-links">
                  {ABOUT_LINKS.map(({ key, url }) => (
                    <button
                      className="about-link-row"
                      key={key}
                      title={t("about.open")}
                      onClick={async () => setAboutError(await openExternal(url))}
                    >
                      <span>{t(`about.${key}`)}</span>
                      <ExternalOpenIcon />
                    </button>
                  ))}
                </div>
                {aboutError && (
                  <div className="ai-theme-error">
                    {t("about.openerFailed")}: {aboutError}
                  </div>
                )}
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
