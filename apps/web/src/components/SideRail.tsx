import { useEffect, useRef } from "react";
import { agentCommand, type AgentConfig, useAgentConfigs } from "../agents";
import { useI18n } from "../i18n";
import { useStore, type PaneView } from "../state/store";
import { queueCommand } from "../terminal/manager";
import { AgentIcon, FilesIcon, GearIcon, TerminalIcon, WebIcon } from "./icons";

/** One entry per pane kind this rail can quick-create. */
const RAIL_ITEMS: Array<{ view: PaneView; label: string; icon: () => JSX.Element }> = [
  { view: "terminal", label: "terminal", icon: TerminalIcon },
  { view: "files", label: "files", icon: FilesIcon },
  { view: "web", label: "web", icon: WebIcon },
];

/**
 * Workspace-level quick-action rail, sitting beside the pane card (like the
 * left sidebar's page tree, but for panes). Not tied to any one pane — each
 * button splits the currently focused pane and opens a fresh one directly in
 * that view, instead of switching an existing pane's view in place (that's
 * still the per-pane header button, toggled via togglePaneView). The settings
 * button is pinned to the bottom (margin-top: auto) so it stays reachable
 * regardless of how many quick-create buttons sit above it.
 */
export function SideRail({
  agentsOpen,
  onAgentsOpenChange,
  onOpenSettings,
  onOpenAgentsSettings,
}: {
  agentsOpen: boolean;
  onAgentsOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
  onOpenAgentsSettings: () => void;
}) {
  const addPane = useStore((s) => s.addPane);
  const { t } = useI18n();
  const agents = useAgentConfigs().filter((agent) => agent.enabled);
  const agentsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentsOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!agentsRef.current?.contains(event.target as Node)) onAgentsOpenChange(false);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [agentsOpen, onAgentsOpenChange]);

  const runAgent = (agent: AgentConfig) => {
    const paneId = addPane("terminal", agent.id);
    const command = agentCommand(agent);
    if (paneId && command) queueCommand(paneId, command);
    onAgentsOpenChange(false);
  };

  const openAgentSettings = () => {
    onAgentsOpenChange(false);
    onOpenAgentsSettings();
  };

  return (
    <div className="side-rail">
      {RAIL_ITEMS.map(({ view, label, icon: Icon }) => (
        <button key={view} className="side-rail-btn" title={`New ${label} pane`} onClick={() => addPane(view)}>
          <Icon />
        </button>
      ))}
      <div className="side-rail-agent" ref={agentsRef}>
        <button
          className={`side-rail-btn ${agentsOpen ? "active" : ""}`}
          title="Run agent"
          onClick={() => onAgentsOpenChange(!agentsOpen)}
        >
          <AgentIcon />
        </button>
        {agentsOpen && (
          <div className="agent-menu">
            {agents.map((agent) => (
              <button key={agent.id} className="agent-menu-item" onClick={() => runAgent(agent)}>
                {agent.icon ? (
                  <img className="agent-menu-icon" src={agent.icon} alt="" aria-hidden="true" />
                ) : (
                  <span className="agent-menu-icon fallback">
                    <AgentIcon />
                  </span>
                )}
                <span>{agent.name}</span>
              </button>
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
      <button className="side-rail-btn side-rail-settings" title="Settings" onClick={onOpenSettings}>
        <GearIcon />
      </button>
    </div>
  );
}
