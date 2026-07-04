import { useState } from "react";
import { activeWorkspace, HTAB_DRAG_MIME, useStore, type TreeNode } from "../state/store";
import { ChevronIcon, CloseIcon, CollapseAllIcon, PageIcon, PlusIcon } from "./icons";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const DRAG_MIME = "application/x-termany-node";

/** One row of the tree + its children, rendered recursively to any depth. */
function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
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
  const [dropPos, setDropPos] = useState<"into" | "before" | "after" | null>(null);

  const hasChildren = node.children.length > 0;

  return (
    <>
      <div
        className={`tree-row ${node.id === activeId ? "active" : ""} ${
          dropPos === "into" ? "drop-target" : ""
        } ${dropPos === "before" ? "drop-before" : ""} ${
          dropPos === "after" ? "drop-after" : ""
        }`}
        style={{ paddingLeft: 6 + depth * 10 }}
        onClick={() => setActiveNode(node.id)}
        draggable={!editing}
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
      </div>

      {node.expanded &&
        node.children.map((c) => <TreeItem key={c.id} node={c} depth={depth + 1} />)}
    </>
  );
}

/** Left sidebar: the workspace's node tree. */
export function TreeSidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const ws = useStore(activeWorkspace);
  const addRootNode = useStore((s) => s.addRootNode);
  const collapseAll = useStore((s) => s.collapseAll);
  const moveNode = useStore((s) => s.moveNode);
  const [rootDrop, setRootDrop] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

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
            title="New page (⌘N)"
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
        className={`tree ${rootDrop ? "root-drop" : ""}`}
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
        {!collapsed && ws.roots.map((n) => <TreeItem key={n.id} node={n} depth={0} />)}
      </div>
    </div>
  );
}
