import { useState } from "react";
import { useI18n } from "../i18n";
import {
  createQuickPrompt,
  loadQuickPrompts,
  saveQuickPrompts,
  type QuickPrompt,
} from "../quickPrompts";
import { ChevronIcon, CloseIcon, PlusIcon, SendIcon } from "./icons";

/**
 * Editor for the rail's quick-input presets, mirroring AgentSettings: a list
 * of rows that expand in place to edit. Clicking a preset in the rail pastes
 * its text into the focused terminal and presses Enter (see submitPrompt).
 */
export function QuickPromptSettings() {
  const { t } = useI18n();
  const [prompts, setPrompts] = useState(loadQuickPrompts);
  const [expanded, setExpanded] = useState<string | null>(null);

  const commit = (next: QuickPrompt[]) => {
    setPrompts(next);
    saveQuickPrompts(next);
  };

  const updatePrompt = (id: string, patch: Partial<QuickPrompt>) => {
    commit(prompts.map((prompt) => (prompt.id === id ? { ...prompt, ...patch } : prompt)));
  };

  const addPrompt = () => {
    const prompt = createQuickPrompt();
    commit([prompt, ...prompts]);
    setExpanded(prompt.id);
  };

  const removePrompt = (id: string) => {
    const next = prompts.filter((prompt) => prompt.id !== id);
    commit(next);
    if (expanded === id) setExpanded(next[0]?.id ?? null);
  };

  return (
    <div className="agent-settings">
      <div className="agent-settings-head">
        <div className="settings-section-title">{t("prompts.title")}</div>
        <div className="agent-settings-head-actions">
          <button className="agent-refresh-btn" onClick={addPrompt}>
            <PlusIcon />
            {t("prompts.add")}
          </button>
        </div>
      </div>

      <div className="agent-settings-list">
        {prompts.map((prompt) => {
          const isExpanded = expanded === prompt.id;
          return (
            <div key={prompt.id} className="agent-settings-row">
              <div className="agent-settings-main">
                <span className="agent-settings-icon fallback" aria-hidden="true">
                  <SendIcon />
                </span>
                <div className="agent-settings-meta">
                  <div className="agent-settings-name">{prompt.name}</div>
                  <div className="agent-settings-command" title={prompt.text}>
                    {prompt.text || t("prompts.textMissing")}
                  </div>
                </div>

                <div className="agent-settings-actions">
                  <div className="agent-enable-toggle" aria-label={`${prompt.name} enabled state`}>
                    <button
                      className={prompt.enabled ? "active" : ""}
                      onClick={() => updatePrompt(prompt.id, { enabled: true })}
                    >
                      {t("prompts.enabled")}
                    </button>
                    <button
                      className={!prompt.enabled ? "active" : ""}
                      onClick={() => updatePrompt(prompt.id, { enabled: false })}
                    >
                      {t("prompts.disabled")}
                    </button>
                  </div>
                  <button
                    className="agent-expand-btn"
                    title={isExpanded ? "Collapse" : "Expand"}
                    onClick={() => setExpanded(isExpanded ? null : prompt.id)}
                  >
                    <ChevronIcon dir={isExpanded ? "up" : "down"} />
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="agent-settings-edit">
                  <label className="agent-field">
                    <span>{t("prompts.name")}</span>
                    <input
                      value={prompt.name}
                      onChange={(e) => updatePrompt(prompt.id, { name: e.target.value })}
                      spellCheck={false}
                    />
                  </label>
                  <label className="agent-field">
                    <span>{t("prompts.text")}</span>
                    <textarea
                      value={prompt.text}
                      rows={3}
                      onChange={(e) => updatePrompt(prompt.id, { text: e.target.value })}
                      spellCheck={false}
                    />
                  </label>
                  <div className="agent-settings-edit-foot">
                    <div className="agent-settings-help">{t("prompts.help")}</div>
                    <button className="agent-remove-btn" onClick={() => removePrompt(prompt.id)}>
                      <CloseIcon />
                      {t("prompts.remove")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
