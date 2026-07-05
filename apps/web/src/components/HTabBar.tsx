import { useState } from "react";
import { isTauri } from "../env";
import { useStore, activeNode, HTAB_DRAG_MIME } from "../state/store";
import { ChevronIcon, CloseIcon, PanelIcon, PanelRightIcon, PlusIcon } from "./icons";

/**
 * Top tab strip. Notion-style, the workspace controls sit at the very left,
 * before the first tab: collapse the sidebar, then step prev/next workspace.
 * Tabs are double-click-to-rename.
 */
export function HTabBar() {
  const node = useStore(activeNode);
  const setActiveHTab = useStore((s) => s.setActiveHTab);
  const addHTab = useStore((s) => s.addHTab);
  const closeHTab = useStore((s) => s.closeHTab);
  const renameHTab = useStore((s) => s.renameHTab);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const railCollapsed = useStore((s) => s.railCollapsed);
  const toggleRail = useStore((s) => s.toggleRail);
  const prevWorkspace = useStore((s) => s.prevWorkspace);
  const nextWorkspace = useStore((s) => s.nextWorkspace);
  const solo = useStore((s) => s.workspaces.length < 2);

  const [editing, setEditing] = useState<string | null>(null);

  // The controls clear the macOS traffic lights only when the sidebar is hidden
  // (collapsed, desktop) — otherwise the lights live over the sidebar header.
  const cls = `htabbar${collapsed && isTauri ? " with-traffic" : ""}`;

  const controls = (
    <div className="htab-controls">
      <button
        className="bar-btn"
        title={collapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
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
          onDoubleClick={() => setEditing(h.id)}
          // Drag a tab onto a tree page to move it there. Off while renaming so
          // the user can select text in the input.
          draggable={editing !== h.id}
          onDragStart={(e) => {
            e.dataTransfer.setData(
              HTAB_DRAG_MIME,
              JSON.stringify({ tabId: h.id, nodeId: node.id })
            );
            e.dataTransfer.effectAllowed = "move";
          }}
        >
          {editing === h.id ? (
            <input
              className="htab-rename"
              autoFocus
              defaultValue={h.title}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                renameHTab(h.id, e.target.value.trim() || h.title);
                setEditing(null);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return; // let the IME handle Enter/Esc
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                else if (e.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <>
              <span className="htab-title">{h.title}</span>
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
            </>
          )}
        </div>
      ))}
      {node && (
        <button className="htab-add" title="New terminal tab (⌘T)" onClick={addHTab}>
          <PlusIcon />
        </button>
      )}
      <button
        className="bar-btn rail-toggle"
        title={railCollapsed ? "Show panel" : "Hide panel"}
        onClick={toggleRail}
      >
        <PanelRightIcon />
      </button>
    </div>
  );
}
