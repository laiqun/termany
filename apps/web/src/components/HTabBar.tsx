import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { beginDragCursor, createDragGhost, endDragCursor, type DragGhost } from "../dragGhost";
import { isTauri } from "../env";
import { resolveDirCwd } from "../fs";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { withShortcut } from "../keybindings";
import { useStore, activeNode, htabLabel, type Pane } from "../state/store";
import { titleBarBackground, useTitleBarGesture } from "../titleBar";
import {
  acknowledgeAgentActivities,
  agentActivitySummary,
  agentActivitySnapshot,
  agentActivityTitle,
  subscribeAgentActivity,
  type AgentActivityStatus,
} from "../terminal/manager";
import { ChevronIcon, CloseIcon, PanelIcon, PanelRightIcon, PlusIcon } from "./icons";
import { useWorktreeTabClose } from "./CloseWorktreeTabDialog";

/**
 * Top tab strip. Notion-style, the workspace controls sit at the very left,
 * before the first tab: collapse the sidebar, then step prev/next workspace.
 * A tab's label is its working directory's name; double-clicking the tab
 * edits that directory inline.
 */
function leafIds(pane: Pane): string[] {
  return pane.kind === "leaf" ? [pane.id] : pane.children.flatMap(leafIds);
}

const ACTIVITY_STATUSES = ["working", "done", "error"] as const;

export function HTabBar() {
  const { t } = useI18n();
  const ime = useImeGuard();
  const node = useStore(activeNode);
  // Labels derive from paths, and home's resolution renames every unset one.
  useStore((s) => s.homeDir);
  const setActiveHTab = useStore((s) => s.setActiveHTab);
  const openPathPrompt = useStore((s) => s.openPathPrompt);
  const setHTabCwd = useStore((s) => s.setHTabCwd);
  const moveHTab = useStore((s) => s.moveHTab);
  const moveHTabToNewNode = useStore((s) => s.moveHTabToNewNode);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const railCollapsed = useStore((s) => s.railCollapsed);
  const toggleRail = useStore((s) => s.toggleRail);
  const prevWorkspace = useStore((s) => s.prevWorkspace);
  const nextWorkspace = useStore((s) => s.nextWorkspace);
  const solo = useStore((s) => s.workspaces.length < 2);

  const [editing, setEditing] = useState<string | null>(null);
  const [cwdInvalid, setCwdInvalid] = useState(false);
  const suppressClickRef = useRef(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const titleBar = useTitleBarGesture();
  // Closing a tab that works in a linked worktree deletes the worktree (and
  // its branch) — the hook asks for confirmation first; anything else closes
  // straight through.
  const { requestClose, dialog: closeDialog } = useWorktreeTabClose();

  // Keep the active tab on screen — a tab created past the right edge would
  // otherwise be active but invisible. `nearest` no-ops when it already is.
  useEffect(() => {
    stripRef.current
      ?.querySelector(`[data-htab-id="${CSS.escape(node?.activeHTab ?? "")}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [node?.activeHTab, node?.htabs.length]);
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
        title={withShortcut(t(collapsed ? "sidebar.show" : "sidebar.hide"), "toggleSidebar")}
        onClick={toggleSidebar}
      >
        <PanelIcon />
      </button>
      <button className="bar-btn" title={t("action.prevWorkspace")} disabled={solo} onClick={prevWorkspace}>
        <ChevronIcon dir="left" />
      </button>
      <button className="bar-btn" title={t("action.nextWorkspace")} disabled={solo} onClick={nextWorkspace}>
        <ChevronIcon dir="right" />
      </button>
    </div>
  );

  // Double-click edits the tab's working directory inline. The typed path is
  // validated via the file-tree listing endpoint (see resolveDirCwd); an
  // invalid path flags the input red (Enter keeps it open) and is dropped on
  // blur. An empty input resets the tab to the home directory.
  const commitTabCwd = async (tabId: string, raw: string): Promise<boolean> => {
    const cwd = await resolveDirCwd(raw);
    if (cwd === null) return false;
    setHTabCwd(tabId, cwd);
    return true;
  };

  const stopEditing = () => {
    setEditing(null);
    setCwdInvalid(false);
  };

  const startTabDrag = (tabId: string, e: React.PointerEvent<HTMLDivElement>) => {
    if (!node || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button,input")) return;
    const fromNodeId = node.id;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const tab = node.htabs.find((h) => h.id === tabId);
    const title = tab ? htabLabel(tab) : "tab";
    let active = false;
    let targetNodeId: string | null = null;
    // Dropped inside the tree but not on a page → the tab becomes its own page.
    let toNewNode = false;
    // Created once the drag passes the movement threshold, so a plain click on
    // a tab never flashes a ghost.
    let ghost: DragGhost | null = null;
    const self = document.querySelector<HTMLElement>(`[data-htab-id="${CSS.escape(tabId)}"]`);

    const clearHover = () => {
      document
        .querySelectorAll(".tree-row.tab-drop-target")
        .forEach((el) => el.classList.remove("tab-drop-target"));
      document
        .querySelectorAll(".tree.tab-drop-new")
        .forEach((el) => el.classList.remove("tab-drop-new"));
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        active = true;
        ghost = createDragGhost(title);
        self?.classList.add("dragging");
        beginDragCursor();
      }
      ev.preventDefault();
      clearHover();
      ghost?.move(ev.clientX, ev.clientY);
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const row = under?.closest<HTMLElement>("[data-tree-node-id]");
      targetNodeId = row?.dataset.treeNodeId ?? null;
      const valid = !!row && !!targetNodeId && targetNodeId !== fromNodeId;
      if (valid) {
        toNewNode = false;
        row!.classList.add("tab-drop-target");
        ghost?.setHint(t("drag.toPage"));
        return;
      }
      // Inside the tree but not on a page — drop here to spin up a new page.
      const tree = !row ? under?.closest<HTMLElement>(".tree") : null;
      toNewNode = !!tree;
      if (tree) tree.classList.add("tab-drop-new");
      ghost?.setHint(tree ? t("drag.newPage") : null);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      clearHover();
      ghost?.destroy();
      self?.classList.remove("dragging");
      endDragCursor();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!active) return;
      suppressClickRef.current = true;
      if (targetNodeId && targetNodeId !== fromNodeId) moveHTab(tabId, fromNodeId, targetNodeId);
      else if (toNewNode) moveHTabToNewNode(tabId, fromNodeId);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // The bar doubles as the window's title bar: its empty parts drag the window
  // and zoom it on a double-click. Both background elements are marked, so the
  // gesture covers the whole bar minus the tabs and buttons — the strip is
  // flex: 1, and it alone accounts for nearly all of that empty space.
  return (
    <>
    <div className={cls} {...titleBar} {...titleBarBackground}>
      {controls}
      {/* Only the tabs scroll; the workspace controls and the panel toggle stay
          pinned to either end. Without this the strip just overflowed and a
          newly created tab sat off-screen, active but invisible. */}
      <div className="htab-strip" ref={stripRef} {...titleBarBackground}>
      {node?.htabs.map((h) => (
        (() => {
          const ids = leafIds(h.layout);
          const activity = agentActivitySummary(ids);
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
                acknowledgeAgentActivities(ids);
              }}
              onDoubleClick={() => setEditing(h.id)}
              onPointerDown={(e) => startTabDrag(h.id, e)}
            >
              {ACTIVITY_STATUSES.map((status: AgentActivityStatus) => {
                const count = activity[status];
                if (!count) return null;
                const label = `${agentActivityTitle({
                  status,
                  updatedAt: 0,
                })} (${count})`;
                return (
                  <span
                    key={status}
                    className="tree-count activity-count"
                    title={label}
                    aria-label={label}
                  >
                    <span className={`agent-dot ${status}`} />
                    {count}
                  </span>
                );
              })}
              {editing === h.id ? (
                <input
                  className={`htab-cwd${cwdInvalid ? " invalid" : ""}`}
                  autoFocus
                  defaultValue={h.cwd ?? ""}
                  placeholder="~"
                  spellCheck={false}
                  {...ime.props}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    // Blur commits a valid path, cancels an invalid one.
                    void commitTabCwd(h.id, e.target.value);
                    stopEditing();
                  }}
                  onKeyDown={(e) => {
                    if (ime.handled(e)) return; // the IME is still using this key
                    if (e.key === "Enter") {
                      void commitTabCwd(h.id, (e.target as HTMLInputElement).value).then((ok) => {
                        if (ok) stopEditing();
                        else setCwdInvalid(true);
                      });
                    } else if (e.key === "Escape") stopEditing();
                  }}
                />
              ) : (
                <>
                  <span className="htab-title" title={h.cwd}>{htabLabel(h)}</span>
                  <button
                    className="htab-close"
                    title={withShortcut(t("common.close"), "closePane")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void requestClose(h);
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
        <button className="htab-add" title={withShortcut(t("action.newTab"), "newTab")} onClick={() => openPathPrompt("tab")}>
          <PlusIcon />
        </button>
      )}
      {/* Placeholder shown only while a pane is dragged over the empty strip —
          previews the tab that dropping would create (see SplitView). */}
      <div className="htab-ghost" aria-hidden="true">
        <PlusIcon />
      </div>
      </div>
      <button
        className="bar-btn rail-toggle"
        title={withShortcut(t(railCollapsed ? "rail.show" : "rail.hide"), "toggleRail")}
        onClick={toggleRail}
      >
        <PanelRightIcon />
      </button>
    </div>
    {closeDialog}
    </>
  );
}
