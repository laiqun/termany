import { isTauri } from "../env";
import { useStore, activeNode } from "../state/store";
import { ChevronIcon, CloseIcon, PanelIcon, PlusIcon } from "./icons";

/**
 * Top tab strip. Notion-style, the workspace controls sit at the very left,
 * before the first tab: collapse the sidebar, then step prev/next workspace.
 */
export function HTabBar() {
  const node = useStore(activeNode);
  const setActiveHTab = useStore((s) => s.setActiveHTab);
  const addHTab = useStore((s) => s.addHTab);
  const closeHTab = useStore((s) => s.closeHTab);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const prevWorkspace = useStore((s) => s.prevWorkspace);
  const nextWorkspace = useStore((s) => s.nextWorkspace);
  const solo = useStore((s) => s.workspaces.length < 2);

  // The controls clear the macOS traffic lights only when the sidebar is hidden
  // (collapsed, desktop) — otherwise the lights live over the sidebar header.
  const cls = `htabbar${collapsed && isTauri ? " with-traffic" : ""}`;

  const controls = (
    <div className="htab-controls">
      <button
        className="bar-btn"
        title={collapsed ? "Show sidebar" : "Hide sidebar"}
        onClick={toggleSidebar}
      >
        <PanelIcon />
      </button>
      <button className="bar-btn" title="Previous workspace" disabled={solo} onClick={prevWorkspace}>
        <ChevronIcon dir="left" />
      </button>
      <button className="bar-btn" title="Next workspace" disabled={solo} onClick={nextWorkspace}>
        <ChevronIcon dir="right" />
      </button>
    </div>
  );

  // The empty parts of the strip drag the window (desktop). Tabs/buttons are
  // interactive, so clicks land on them, not the drag region.
  return (
    <div className={cls} data-tauri-drag-region>
      {controls}
      {node?.htabs.map((h) => (
        <div
          key={h.id}
          className={`htab ${h.id === node.activeHTab ? "active" : ""}`}
          onClick={() => setActiveHTab(h.id)}
        >
          <span>{h.title}</span>
          <button
            className="htab-close"
            title="Close (⌘W)"
            onClick={(e) => {
              e.stopPropagation();
              closeHTab(h.id);
            }}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
      {node && (
        <button className="htab-add" title="New terminal tab (⌘T)" onClick={addHTab}>
          <PlusIcon />
        </button>
      )}
    </div>
  );
}
