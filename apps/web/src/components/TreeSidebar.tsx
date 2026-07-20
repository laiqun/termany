import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { beginDragCursor, createDragGhost, endDragCursor, type DragGhost } from "../dragGhost";
import { useI18n } from "../i18n";
import { withShortcut } from "../keybindings";
import { activeWorkspace, HTAB_DRAG_MIME, useStore, type TreeNode } from "../state/store";
import {
  aggregateAgentActivity,
  agentActivitySnapshot,
  agentActivityTitle,
  subscribeAgentActivity,
} from "../terminal/manager";
import { ChevronIcon, CloseIcon, CollapseAllIcon, PageIcon, PlusIcon } from "./icons";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const DRAG_MIME = "application/x-termany-node";
type TreeDropPos = "into" | "before" | "after";
type NodeDragUi = { id: string; targetId: string | null; pos: TreeDropPos | null; overTree: boolean };

function paneLeafIds(pane: TreeNode["htabs"][number]["layout"]): string[] {
  return pane.kind === "leaf" ? [pane.id] : pane.children.flatMap(paneLeafIds);
}

function subtreeLeafIds(node: TreeNode): string[] {
  return [
    ...node.htabs.flatMap((h) => paneLeafIds(h.layout)),
    ...node.children.flatMap(subtreeLeafIds),
  ];
}

/** One row of the tree + its children, rendered recursively to any depth. */
function TreeItem({
  node,
  depth,
  nodeDrag,
  onNodePointerDown,
  consumeSuppressedClick,
}: {
  node: TreeNode;
  depth: number;
  nodeDrag: NodeDragUi | null;
  onNodePointerDown: (id: string, e: ReactPointerEvent<HTMLDivElement>) => void;
  consumeSuppressedClick: () => boolean;
}) {
  const activeId = useStore((s) => activeWorkspace(s).activeNode);
  const setActiveNode = useStore((s) => s.setActiveNode);
  const toggleExpand = useStore((s) => s.toggleExpand);
  const addChildNode = useStore((s) => s.addChildNode);
  const deleteNode = useStore((s) => s.deleteNode);
  const renameNode = useStore((s) => s.renameNode);
  const moveNode = useStore((s) => s.moveNode);
  const moveHTab = useStore((s) => s.moveHTab);
  const [editing, setEditing] = useState(false);
  // Where a drag over this row would land: nest into it, or reorder as a
  // sibling before/after it (top/bottom quarter of the row).
  const [dropPos, setDropPos] = useState<TreeDropPos | null>(null);
  const pointerDropPos = nodeDrag?.targetId === node.id ? nodeDrag.pos : null;
  const activeDropPos = pointerDropPos ?? dropPos;

  const hasChildren = node.children.length > 0;
  const activity = aggregateAgentActivity(subtreeLeafIds(node));

  return (
    <>
      <div
        className={`tree-row ${node.id === activeId ? "active" : ""} ${
          activeDropPos === "into" ? "drop-target" : ""
        } ${activeDropPos === "before" ? "drop-before" : ""} ${
          activeDropPos === "after" ? "drop-after" : ""
        } ${nodeDrag?.id === node.id ? "dragging" : ""}`}
        data-tree-node-id={node.id}
        style={{ paddingLeft: 6 + depth * 10 }}
        onClick={(e) => {
          if (consumeSuppressedClick()) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          setActiveNode(node.id);
        }}
        onPointerDown={(e) => {
          if (!editing) onNodePointerDown(node.id, e);
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, node.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          const { types } = e.dataTransfer;
          if (!types.includes(DRAG_MIME) && !types.includes(HTAB_DRAG_MIME)) return;
          e.preventDefault();
          e.stopPropagation(); // over a row, don't also light up the root-drop area
          e.dataTransfer.dropEffect = "move";
          // Tabs always drop INTO a page; page drags pick a zone by cursor Y.
          if (!types.includes(DRAG_MIME)) {
            setDropPos("into");
            return;
          }
          const r = e.currentTarget.getBoundingClientRect();
          const y = (e.clientY - r.top) / r.height;
          setDropPos(y < 0.25 ? "before" : y > 0.75 ? "after" : "into");
        }}
        onDragLeave={() => setDropPos(null)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation(); // drop ON a row handled here; empty area by container
          const pos = dropPos ?? "into";
          setDropPos(null);
          // A tab dropped onto this page moves the whole terminal tab here.
          const htab = e.dataTransfer.getData(HTAB_DRAG_MIME);
          if (htab) {
            const { tabId, nodeId } = JSON.parse(htab);
            moveHTab(tabId, nodeId, node.id);
            return;
          }
          const dragId = e.dataTransfer.getData(DRAG_MIME);
          if (dragId) moveNode(dragId, node.id, pos);
        }}
      >
        <button
          className={`tree-twisty ${hasChildren ? "" : "leaf"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) toggleExpand(node.id);
          }}
        >
          {hasChildren ? (
            // Every row reads as a page by default; the chevron only appears
            // on hover (CSS swaps the two), like Notion's sidebar.
            <>
              <span className="twisty-page">
                <PageIcon />
              </span>
              <span className="twisty-chevron">
                <ChevronIcon dir={node.expanded ? "down" : "right"} />
              </span>
            </>
          ) : (
            <PageIcon />
          )}
        </button>

        {editing ? (
          <input
            className="tree-rename"
            autoFocus
            defaultValue={node.title}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              renameNode(node.id, e.target.value.trim() || node.title);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return; // let the IME handle Enter/Esc
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span
            className="tree-title"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            {node.title}
          </span>
        )}
        <button
          className="tree-act"
          title="Add nested page"
          onClick={(e) => {
            e.stopPropagation();
            addChildNode(node.id);
          }}
        >
          <PlusIcon />
        </button>
        <button
          className="tree-act"
          title="Delete (and everything under it)"
          onClick={(e) => {
            e.stopPropagation();
            deleteNode(node.id);
          }}
        >
          <CloseIcon />
        </button>
        {node.htabs.length > 1 && (
          <span className="tree-count" title={`${node.htabs.length} terminals`}>
            {node.htabs.length}
          </span>
        )}
        {activity && (
          <span
            className={`agent-dot ${activity.status}`}
            title={agentActivityTitle(activity)}
            aria-label={agentActivityTitle(activity)}
          />
        )}
      </div>

      {node.expanded &&
        node.children.map((c) => (
          <TreeItem
            key={c.id}
            node={c}
            depth={depth + 1}
            nodeDrag={nodeDrag}
            onNodePointerDown={onNodePointerDown}
            consumeSuppressedClick={consumeSuppressedClick}
          />
        ))}
    </>
  );
}

/** Left sidebar: the workspace's node tree. */
export function TreeSidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const ws = useStore(activeWorkspace);
  const addRootNode = useStore((s) => s.addRootNode);
  const collapseAll = useStore((s) => s.collapseAll);
  const moveNode = useStore((s) => s.moveNode);
  const [rootDrop, setRootDrop] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [nodeDrag, setNodeDrag] = useState<NodeDragUi | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // Keep the active page on screen. Creating a page (⌘N / ⌘⏎) appends it below
  // everything else, which in a long tree lands outside the scroll viewport —
  // the page would become active with nothing visibly happening. `nearest`
  // makes this a no-op when the row is already in view, so plain clicks and
  // ⌘P jumps don't yank the sidebar around.
  useEffect(() => {
    treeRef.current
      ?.querySelector(`[data-tree-node-id="${CSS.escape(ws.activeNode)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [ws.activeNode, ws.roots]);
  const dragRef = useRef<{
    id: string;
    title: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  // Cursor-following label, created once the drag passes the 4px threshold.
  const ghostRef = useRef<DragGhost | null>(null);
  const dragUiRef = useRef<NodeDragUi | null>(null);
  const suppressClickRef = useRef(false);
  const wsLeafIds = ws.roots.flatMap(subtreeLeafIds);
  useSyncExternalStore(
    subscribeAgentActivity,
    () => agentActivitySnapshot(wsLeafIds),
    () => ""
  );

  const setDragUi = (next: NodeDragUi | null) => {
    dragUiRef.current = next;
    setNodeDrag(next);
  };

  const startNodePointerDrag = (id: string, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("button,input")) return;
    // Resolve the title now, while the tree is in scope — the pointer handlers
    // below live in an effect that only re-subscribes on moveNode.
    const title = target?.closest<HTMLElement>("[data-tree-node-id]")?.innerText.trim() || "page";
    dragRef.current = {
      id,
      title: title.split("\n")[0],
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
  };

  const consumeSuppressedClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.hypot(dx, dy) < 4) return;
        drag.active = true;
        ghostRef.current = createDragGhost(drag.title);
        beginDragCursor();
      }
      e.preventDefault();
      ghostRef.current?.move(e.clientX, e.clientY);

      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const row = hit instanceof Element ? hit.closest<HTMLElement>("[data-tree-node-id]") : null;
      const tree = treeRef.current;
      if (row && tree?.contains(row)) {
        const targetId = row.dataset.treeNodeId;
        if (!targetId || targetId === drag.id) {
          ghostRef.current?.setHint(null);
          setDragUi({ id: drag.id, targetId: null, pos: null, overTree: false });
          return;
        }
        const r = row.getBoundingClientRect();
        const y = (e.clientY - r.top) / r.height;
        const pos: TreeDropPos = y < 0.25 ? "before" : y > 0.75 ? "after" : "into";
        ghostRef.current?.setHint(t(`drag.node.${pos}`));
        setDragUi({ id: drag.id, targetId, pos, overTree: true });
        return;
      }

      const overTree = !!(hit && tree?.contains(hit));
      ghostRef.current?.setHint(overTree ? t("drag.node.root") : null);
      setDragUi({ id: drag.id, targetId: null, pos: null, overTree });
    };

    const onPointerUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const wasActive = drag.active;
      const ui = dragUiRef.current;
      dragRef.current = null;
      ghostRef.current?.destroy();
      ghostRef.current = null;
      endDragCursor();
      setDragUi(null);
      if (!wasActive) return;
      suppressClickRef.current = true;
      if (!ui?.overTree) return;
      if (ui.targetId) moveNode(drag.id, ui.targetId, ui.pos ?? "into");
      else moveNode(drag.id, null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [moveNode]);

  return (
    <div className="sidebar">
      <WorkspaceSwitcher onOpenSettings={onOpenSettings} />
      {/* VS Code-style section header: collapse toggle + title + actions. */}
      <div className="section-head">
        <button className="section-toggle" onClick={() => setCollapsed((c) => !c)}>
          <span className="section-chevron">
            <ChevronIcon dir={collapsed ? "right" : "down"} />
          </span>
          <span className="section-title">PAGES</span>
        </button>
        <div className="section-actions">
          <button
            className="mini"
            title={withShortcut("New page", "newPage")}
            onClick={(e) => {
              e.stopPropagation();
              addRootNode();
            }}
          >
            <PlusIcon />
          </button>
          <button
            className="mini"
            title="Collapse all"
            onClick={(e) => {
              e.stopPropagation();
              collapseAll();
            }}
          >
            <CollapseAllIcon />
          </button>
        </div>
      </div>
      {/* Dropping on empty space moves the node back to the top level. */}
      <div
        ref={treeRef}
        className={`tree ${rootDrop || (nodeDrag?.overTree && nodeDrag.targetId === null) ? "root-drop" : ""}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
          e.preventDefault();
          setRootDrop(true);
        }}
        onDragLeave={() => setRootDrop(false)}
        onDrop={(e) => {
          setRootDrop(false);
          const dragId = e.dataTransfer.getData(DRAG_MIME);
          if (dragId) moveNode(dragId, null);
        }}
      >
        {!collapsed &&
          ws.roots.map((n) => (
            <TreeItem
              key={n.id}
              node={n}
              depth={0}
              nodeDrag={nodeDrag}
              onNodePointerDown={startNodePointerDrag}
              consumeSuppressedClick={consumeSuppressedClick}
            />
          ))}
      </div>
    </div>
  );
}
