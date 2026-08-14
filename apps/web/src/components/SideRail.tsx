import { useEffect, useRef, useState } from "react";
import { agentCommand, type AgentConfig, useAgentConfigs } from "../agents";
import { useI18n } from "../i18n";
import { withShortcut } from "../keybindings";
import { registerOccluder, unregisterOccluder } from "../nativeViewOcclusion";
import { useQuickPrompts, type QuickPrompt } from "../quickPrompts";
import { activeHtab, useStore, type PaneView } from "../state/store";
import { queueCommand, submitPrompt } from "../terminal/manager";
import {
  ActivityIcon,
  AgentIcon,
  ChartIcon,
  ChatIcon,
  FilesIcon,
  GearIcon,
  GitBranchIcon,
  HistoryIcon,
  SendIcon,
  TerminalIcon,
  WebIcon,
} from "./icons";

const AGENT_MENU_OCCLUDER_ID = "side-rail-agent-menu";
const PROMPT_MENU_OCCLUDER_ID = "side-rail-prompt-menu";

/** One entry per pane kind this rail can quick-create. */
const RAIL_ITEMS: Array<{ view: PaneView; icon: () => JSX.Element }> = [
  { view: "terminal", icon: TerminalIcon },
  { view: "files", icon: FilesIcon },
  { view: "git", icon: GitBranchIcon },
  { view: "agent", icon: ChatIcon },
  { view: "web", icon: WebIcon },
  { view: "monitor", icon: ActivityIcon },
];

/** Dashboard shortcuts stay below the agent launcher, matching the rail's
 * existing visual order, but use the same new-pane path as every item above. */
const DASHBOARD_RAIL_ITEMS: Array<{ view: PaneView; icon: () => JSX.Element }> = [
  { view: "history", icon: HistoryIcon },
  { view: "usage", icon: ChartIcon },
];

/**
 * Workspace-level quick-action rail, sitting beside the pane card (like the
 * left sidebar's page tree, but for panes). Not tied to any one pane — each
 * button splits the currently focused pane and opens a fresh one directly in
 * that view, instead of switching an existing pane's view in place (that's
 * still the per-pane header button, toggled via togglePaneView). The settings
 * button is pinned to the bottom (margin-top: auto) so it stays reachable
 * regardless of how many quick-create buttons sit above it; it ships hidden
 * (see DEFAULT_RAIL_VISIBILITY) since the openSettings keybinding covers it.
 */
export function SideRail({
  agentsOpen,
  onAgentsOpenChange,
  onOpenSettings,
  onOpenAgentsSettings,
  onOpenPromptsSettings,
}: {
  agentsOpen: boolean;
  onAgentsOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
  onOpenAgentsSettings: () => void;
  onOpenPromptsSettings: () => void;
}) {
  const addPane = useStore((s) => s.addPane);
  const setPaneView = useStore((s) => s.setPaneView);
  const setAgentRuntime = useStore((s) => s.setAgentRuntime);
  const railVisibility = useStore((s) => s.railVisibility);
  const { t } = useI18n();
  const agents = useAgentConfigs().filter((agent) => agent.enabled);
  const prompts = useQuickPrompts().filter((prompt) => prompt.enabled && prompt.text.trim());
  const [promptsOpen, setPromptsOpen] = useState(false);
  const agentsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const promptsRef = useRef<HTMLDivElement>(null);
  const promptMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentsOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!agentsRef.current?.contains(event.target as Node)) onAgentsOpenChange(false);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [agentsOpen, onAgentsOpenChange]);

  useEffect(() => {
    if (!promptsOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!promptsRef.current?.contains(event.target as Node)) setPromptsOpen(false);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [promptsOpen]);

  useEffect(() => {
    if (!railVisibility.agents && agentsOpen) onAgentsOpenChange(false);
  }, [agentsOpen, onAgentsOpenChange, railVisibility.agents]);

  useEffect(() => {
    if (!railVisibility.prompts && promptsOpen) setPromptsOpen(false);
  }, [promptsOpen, railVisibility.prompts]);

  // Only blanks the web/office preview pane(s) this dropdown actually
  // overlaps, not every native webview in the workspace (see nativeViewOcclusion).
  useEffect(() => {
    if (!agentsOpen) return;
    const el = menuRef.current;
    if (!el) return;
    const update = () => registerOccluder(AGENT_MENU_OCCLUDER_ID, el.getBoundingClientRect());
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      unregisterOccluder(AGENT_MENU_OCCLUDER_ID);
    };
  }, [agentsOpen]);

  useEffect(() => {
    if (!promptsOpen) return;
    const el = promptMenuRef.current;
    if (!el) return;
    const update = () => registerOccluder(PROMPT_MENU_OCCLUDER_ID, el.getBoundingClientRect());
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      unregisterOccluder(PROMPT_MENU_OCCLUDER_ID);
    };
  }, [promptsOpen]);

  const runAgent = (agent: AgentConfig) => {
    const paneId = addPane("terminal", agent.id);
    const command = agentCommand(agent);
    if (paneId && command) queueCommand(paneId, command);
    onAgentsOpenChange(false);
  };

  const openAgent = (agent: AgentConfig) => {
    if (!agent.runtime) {
      runAgent(agent);
      return;
    }
    const paneId = addPane("agent", agent.name);
    if (paneId) setAgentRuntime(paneId, agent.id);
    onAgentsOpenChange(false);
  };

  const openAgentSettings = () => {
    onAgentsOpenChange(false);
    onOpenAgentsSettings();
  };

  const insertPrompt = (prompt: QuickPrompt) => {
    const paneId = activeHtab(useStore.getState())?.focused;
    if (paneId) submitPrompt(paneId, prompt.text);
    setPromptsOpen(false);
  };

  const openPromptSettings = () => {
    setPromptsOpen(false);
    onOpenPromptsSettings();
  };

  const openPane = (view: PaneView) => {
    const paneId = addPane(view);
    if (paneId) return;
    const focused = activeHtab(useStore.getState())?.focused;
    if (focused) setPaneView(focused, view);
  };

  return (
    <div className="side-rail">
      {RAIL_ITEMS.filter(({ view }) => railVisibility[view]).map(({ view, icon: Icon }) => (
        <button key={view} className="side-rail-btn" title={t("rail.newPane", { view: t(`pane.view.${view}`) })} onClick={() => openPane(view)}>
          <Icon />
        </button>
      ))}
      {railVisibility.agents && (
        <div className="side-rail-agent" ref={agentsRef}>
          <button
            className={`side-rail-btn ${agentsOpen ? "active" : ""}`}
            title={t("rail.runAgent")}
            onClick={() => onAgentsOpenChange(!agentsOpen)}
          >
            <AgentIcon />
          </button>
          {agentsOpen && (
            <div className="agent-menu" ref={menuRef}>
              {agents.map((agent) => (
                <div key={agent.id} className="agent-menu-entry">
                  <button className="agent-menu-item" onClick={() => openAgent(agent)}>
                    {agent.icon ? (
                      <img className="agent-menu-icon" src={agent.icon} alt="" aria-hidden="true" />
                    ) : (
                      <span className="agent-menu-icon fallback">
                        <AgentIcon />
                      </span>
                    )}
                    <span>{agent.name}</span>
                    {agent.runtime && <ChatIcon />}
                  </button>
                  {agent.runtime && (
                    <button
                      className="agent-menu-terminal"
                      title={`${t("agents.openTerminal")}: ${agent.name}`}
                      onClick={() => runAgent(agent)}
                    >
                      <TerminalIcon />
                    </button>
                  )}
                </div>
              ))}
              {agents.length === 0 && <div className="agent-menu-empty">{t("agents.noEnabled")}</div>}
              <div className="agent-menu-separator" />
              <button className="agent-menu-item agent-menu-settings" onClick={openAgentSettings}>
                <GearIcon />
                <span>{t("agents.settings")}</span>
              </button>
            </div>
          )}
        </div>
      )}
      {railVisibility.prompts && (
        <div className="side-rail-agent" ref={promptsRef}>
          <button
            className={`side-rail-btn ${promptsOpen ? "active" : ""}`}
            title={t("rail.prompts")}
            onClick={() => setPromptsOpen(!promptsOpen)}
          >
            <SendIcon />
          </button>
          {promptsOpen && (
            <div className="agent-menu prompt-menu" ref={promptMenuRef}>
              {prompts.map((prompt) => (
                <button
                  key={prompt.id}
                  className="agent-menu-item prompt-menu-item"
                  onClick={() => insertPrompt(prompt)}
                >
                  <span className="prompt-menu-name">{prompt.name}</span>
                  <span className="prompt-menu-text">{prompt.text}</span>
                </button>
              ))}
              {prompts.length === 0 && <div className="agent-menu-empty">{t("prompts.noEnabled")}</div>}
              <div className="agent-menu-separator" />
              <button className="agent-menu-item agent-menu-settings" onClick={openPromptSettings}>
                <GearIcon />
                <span>{t("prompts.settings")}</span>
              </button>
            </div>
          )}
        </div>
      )}
      {DASHBOARD_RAIL_ITEMS.filter(({ view }) => railVisibility[view]).map(({ view, icon: Icon }) => (
        <button
          key={view}
          className="side-rail-btn"
          title={t("rail.newPane", { view: t(`pane.view.${view}`) })}
          onClick={() => openPane(view)}
        >
          <Icon />
        </button>
      ))}
      {railVisibility.settings && (
        <button
          className="side-rail-btn side-rail-settings"
          title={withShortcut(t("workspace.settings"), "openSettings")}
          onClick={onOpenSettings}
        >
          <GearIcon />
        </button>
      )}
    </div>
  );
}
