import { useEffect, useRef } from "react";
import { agentCommand, type AgentConfig, useAgentConfigs } from "../agents";
import { useI18n } from "../i18n";
import { withShortcut } from "../keybindings";
import { registerOccluder, unregisterOccluder } from "../nativeViewOcclusion";
import { activeHtab, useStore, type PaneView } from "../state/store";
import { queueCommand } from "../terminal/manager";
import { AgentIcon, FilesIcon, GearIcon, TerminalIcon, WebIcon } from "./icons";

const AGENT_MENU_OCCLUDER_ID = "side-rail-agent-menu";

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
  const setPaneView = useStore((s) => s.setPaneView);
  const { t } = useI18n();
  const agents = useAgentConfigs().filter((agent) => agent.enabled);
  const agentsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentsOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!agentsRef.current?.contains(event.target as Node)) onAgentsOpenChange(false);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [agentsOpen, onAgentsOpenChange]);

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

  const openPane = (view: PaneView) => {
    const paneId = addPane(view);
    if (paneId) return;
    const focused = activeHtab(useStore.getState())?.focused;
    if (focused) setPaneView(focused, view);
  };

  return (
    <div className="side-rail">
      {RAIL_ITEMS.map(({ view, label, icon: Icon }) => (
        <button key={view} className="side-rail-btn" title={`New ${label} pane`} onClick={() => openPane(view)}>
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
          <div className="agent-menu" ref={menuRef}>
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
      <button
        className="side-rail-btn side-rail-settings"
        title={withShortcut("Settings", "openSettings")}
        onClick={onOpenSettings}
      >
        <GearIcon />
      </button>
    </div>
  );
}
