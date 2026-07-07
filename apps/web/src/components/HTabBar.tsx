import { getCurrentWindow } from "@tauri-apps/api/window";
import { useRef, useState, useSyncExternalStore } from "react";
import { isTauri } from "../env";
import { useStore, activeNode, type Pane } from "../state/store";
import {
  aggregateAgentActivity,
  agentActivitySnapshot,
  agentActivityTitle,
  subscribeAgentActivity,
} from "../terminal/manager";
import { ChevronIcon, CloseIcon, PanelIcon, PanelRightIcon, PlusIcon } from "./icons";

/**
 * Top tab strip. Notion-style, the workspace controls sit at the very left,
 * before the first tab: collapse the sidebar, then step prev/next workspace.
 * Tabs are double-click-to-rename.
 */
function leafIds(pane: Pane): string[] {
  return pane.kind === "leaf" ? [pane.id] : pane.children.flatMap(leafIds);
}

export function HTabBar() {
  const node = useStore(activeNode);
  const setActiveHTab = useStore((s) => s.setActiveHTab);
  const addHTab = useStore((s) => s.addHTab);
  const closeHTab = useStore((s) => s.closeHTab);
  const renameHTab = useStore((s) => s.renameHTab);
  const moveHTab = useStore((s) => s.moveHTab);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const railCollapsed = useStore((s) => s.railCollapsed);
  const toggleRail = useStore((s) => s.toggleRail);
  const prevWorkspace = useStore((s) => s.prevWorkspace);
  const nextWorkspace = useStore((s) => s.nextWorkspace);
  const solo = useStore((s) => s.workspaces.length < 2);

  const [editing, setEditing] = useState<string | null>(null);
  const suppressClickRef = useRef(false);
  const nodeLeafIds = node?.htabs.flatMap((h) => leafIds(h.layout)) ?? [];
  useSyncExternalStore(
    subscribeAgentActivity,
    () => agentActivitySnapshot(nodeLeafIds),
    () => ""
  );

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
  // interactive, so clicks land on them, not the drag region. Double-clicking
  // that same empty area zooms the window, macOS title-bar style — guarded to
  // the bar itself so it doesn't fire from a bubbled tab/button dblclick.
  const onBarDoubleClick = (e: React.MouseEvent) => {
    if (!isTauri || e.target !== e.currentTarget) return;
    void getCurrentWindow().toggleMaximize();
  };

  const startTabDrag = (tabId: string, e: React.PointerEvent<HTMLDivElement>) => {
    if (!node || e.button !== 0 || editing === tabId) return;
    if ((e.target as HTMLElement).closest("button,input")) return;
    const fromNodeId = node.id;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    let targetNodeId: string | null = null;

    const clearHover = () => {
      document
        .querySelectorAll(".tree-row.tab-drop-target")
        .forEach((el) => el.classList.remove("tab-drop-target"));
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        active = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      ev.preventDefault();
      clearHover();
      const row = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>("[data-tree-node-id]");
      targetNodeId = row?.dataset.treeNodeId ?? null;
      if (row && targetNodeId && targetNodeId !== fromNodeId) row.classList.add("tab-drop-target");
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      clearHover();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!active) return;
      suppressClickRef.current = true;
      if (targetNodeId && targetNodeId !== fromNodeId) moveHTab(tabId, fromNodeId, targetNodeId);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div className={cls} data-tauri-drag-region onDoubleClick={onBarDoubleClick}>
      {controls}
      {node?.htabs.map((h) => (
        (() => {
          const activity = aggregateAgentActivity(leafIds(h.layout));
          return (
            <div
              key={h.id}
              data-htab-id={h.id}
              className={`htab ${h.id === node.activeHTab ? "active" : ""}`}
              onClick={(e) => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  e.preventDefault();
                  return;
                }
                setActiveHTab(h.id);
              }}
              onDoubleClick={() => setEditing(h.id)}
              onPointerDown={(e) => startTabDrag(h.id, e)}
            >
              {activity && (
                <span
                  className={`agent-dot ${activity.status}`}
                  title={agentActivityTitle(activity)}
                  aria-label={agentActivityTitle(activity)}
                />
              )}
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
          );
        })()
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
