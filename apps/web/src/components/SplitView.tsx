import { Fragment, useEffect, useRef, useState } from "react";
import { beginDragCursor, createDragGhost, endDragCursor } from "../dragGhost";
import { useI18n } from "../i18n";
import { withShortcut } from "../keybindings";
import { activeHtab, paneCount, useStore, type DropEdge, type HTab, type Pane } from "../state/store";
import { focusSession } from "../terminal/manager";
import { FileTree } from "./FileTree";
import { CloseIcon, FilesIcon, MaximizeIcon, RestoreIcon, TerminalIcon, WebIcon } from "./icons";
import { TerminalPane } from "./TerminalPane";
import { WebBrowserPane } from "./WebBrowserPane";

type Leaf = Pane & { kind: "leaf" };
type PaneDropTarget = { id: string; edge: DropEdge } | null;

function findLeaf(pane: Pane, id: string): Leaf | undefined {
  if (pane.kind === "leaf") return pane.id === id ? pane : undefined;
  for (const c of pane.children) {
    const hit = findLeaf(c, id);
    if (hit) return hit;
  }
  return undefined;
}

/** Pick the nearest edge of a rect for the given cursor point. */
function edgeFor(rect: DOMRect, x: number, y: number): DropEdge {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
  return (Object.keys(d) as DropEdge[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

/** The header bar of a pane: drag handle, editable name, magnify + close. */
function PaneHeader({
  leaf,
  solo,
  onPointerDown,
}: {
  leaf: Leaf;
  solo: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const renamePane = useStore((s) => s.renamePane);
  const closePane = useStore((s) => s.closePane);
  const toggleMaximize = useStore((s) => s.toggleMaximize);
  const setPaneView = useStore((s) => s.setPaneView);
  const [editing, setEditing] = useState(false);
  const showingFiles = leaf.view === "files";
  const showingWeb = leaf.view === "web";
  const nextView = showingFiles ? "terminal" : "files";
  const renameWidth = `${Math.max(8, leaf.title.length + 1)}ch`;

  // Double-clicking the header zooms the pane, same as the maximize button —
  // but not while renaming, and not when the dblclick lands on the title
  // (renames instead) or an action button.
  const onHeaderDoubleClick = (e: React.MouseEvent) => {
    if (editing) return;
    if ((e.target as HTMLElement).closest(".pane-head-title,.pane-head-actions")) return;
    toggleMaximize(leaf.id);
  };

  return (
    <div
      className="pane-head"
      onPointerDown={editing ? undefined : onPointerDown}
      onDoubleClick={onHeaderDoubleClick}
    >
      <span className="pane-head-icon">
        {showingFiles ? <FilesIcon /> : showingWeb ? <WebIcon /> : <TerminalIcon />}
      </span>
      <span className="pane-head-name">
        {editing ? (
          <input
            className="pane-head-rename"
            style={{ width: renameWidth }}
            autoFocus
            defaultValue={leaf.title}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              renamePane(leaf.id, e.target.value.trim() || leaf.title);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return; // let the IME handle Enter/Esc
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="pane-head-title" onDoubleClick={() => setEditing(true)}>
            {leaf.title}
          </span>
        )}
      </span>
      <span className="pane-head-spacer" />
      <div className="pane-head-actions">
        {!showingWeb && (
          <button
            className="pane-btn"
            title={showingFiles ? "Show terminal" : "Show file tree"}
            onClick={() => setPaneView(leaf.id, nextView)}
          >
            {showingFiles ? <TerminalIcon /> : <FilesIcon />}
          </button>
        )}
        <button
          className="pane-btn"
          title={withShortcut(solo ? "Restore" : "Maximize", "toggleMaximize")}
          onClick={() => toggleMaximize(leaf.id)}
        >
          {solo ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button className="pane-btn" title={withShortcut("Close pane", "closePane")} onClick={() => closePane(leaf.id)}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

/** One terminal pane: header + terminal, click-to-focus, drag-drop target. */
function PaneSlot({
  leaf,
  showFocus,
  solo,
  dropTarget,
  onPaneDragStart,
}: {
  leaf: Leaf;
  showFocus: boolean;
  solo: boolean;
  dropTarget: PaneDropTarget;
  onPaneDragStart: (id: string, e: React.PointerEvent) => void;
}) {
  const focused = useStore((s) => activeHtab(s)?.focused === leaf.id);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const dropEdge = dropTarget?.id === leaf.id ? dropTarget.edge : null;

  useEffect(() => {
    if (focused) focusSession(leaf.id);
  }, [focused, leaf.id]);

  return (
    <div
      data-pane-id={leaf.id}
      className={`pane-slot ${showFocus && focused ? "focused" : ""}`}
      onMouseDown={() => setFocusedPane(leaf.id)}
    >
      <PaneHeader leaf={leaf} solo={solo} onPointerDown={(e) => onPaneDragStart(leaf.id, e)} />
      <div className="pane-body">
        {leaf.view === "files" ? (
          <FileTree
            sessionId={leaf.id}
            initialCwdFrom={leaf.cwdFrom}
            explicitRoot={leaf.filesRoot}
            explicitSelected={leaf.filesSelected}
          />
        ) : leaf.view === "web" ? (
          <WebBrowserPane id={leaf.id} />
        ) : (
          <TerminalPane id={leaf.id} />
        )}
        {dropEdge && <div className={`drop-ind drop-ind-${dropEdge}`} />}
      </div>
    </div>
  );
}

/** Evenly-sized fractions when none are stored yet (or a stale-length array). */
function normalizeSizes(sizes: number[] | undefined, n: number): number[] {
  if (sizes && sizes.length === n) return sizes;
  return Array.from({ length: n }, () => 1 / n);
}

const MIN_FRACTION = 0.08; // a pane can't be dragged smaller than this share

/**
 * Recursively render a pane layout: leaves as slots, splits as flex rows/cols
 * with a draggable gutter between each pair. `path` is the child-index trail to
 * this split node, used to address it when committing a resize to the store.
 */
function SplitTree({
  pane,
  showFocus,
  path,
  dropTarget,
  onPaneDragStart,
}: {
  pane: Pane;
  showFocus: boolean;
  path: number[];
  dropTarget: PaneDropTarget;
  onPaneDragStart: (id: string, e: React.PointerEvent) => void;
}) {
  const resizeSplit = useStore((s) => s.resizeSplit);
  const containerRef = useRef<HTMLDivElement>(null);

  if (pane.kind === "leaf") {
    return (
      <PaneSlot
        leaf={pane}
        showFocus={showFocus}
        solo={false}
        dropTarget={dropTarget}
        onPaneDragStart={onPaneDragStart}
      />
    );
  }

  const sizes = normalizeSizes(pane.sizes, pane.children.length);
  const horizontal = pane.dir === "row";

  // Drag the gutter between child `i` and child `i+1`, trading size between them.
  const startDrag = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    if (total <= 0) return;
    const startPos = horizontal ? e.clientX : e.clientY;
    const base = [...sizes];

    const onMove = (ev: MouseEvent) => {
      const cur = horizontal ? ev.clientX : ev.clientY;
      let delta = (cur - startPos) / total;
      // Keep both neighbours above the minimum share.
      delta = Math.max(delta, MIN_FRACTION - base[i]);
      delta = Math.min(delta, base[i + 1] - MIN_FRACTION);
      const next = [...base];
      next[i] = base[i] + delta;
      next[i + 1] = base[i + 1] - delta;
      resizeSplit(path, next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className={`split ${pane.dir}`} ref={containerRef}>
      {pane.children.map((child, i) => (
        <Fragment key={leafKey(child)}>
          {i > 0 && (
            <div
              className={`split-gutter ${pane.dir}`}
              onMouseDown={(e) => startDrag(i - 1, e)}
            />
          )}
          <div className="split-cell" style={{ flexGrow: sizes[i] }}>
            <SplitTree
              pane={child}
              showFocus={showFocus}
              path={[...path, i]}
              dropTarget={dropTarget}
              onPaneDragStart={onPaneDragStart}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function leafKey(pane: Pane): string {
  return pane.kind === "leaf" ? pane.id : pane.children.map(leafKey).join("|");
}

/** Top-level: render the magnified pane alone, or the full split tree. */
export function SplitView({ htab }: { htab: HTab }) {
  const { t } = useI18n();
  const movePane = useStore((s) => s.movePane);
  const movePaneToHTab = useStore((s) => s.movePaneToHTab);
  const movePaneToNewHTab = useStore((s) => s.movePaneToNewHTab);
  const movePaneToNode = useStore((s) => s.movePaneToNode);
  const [dropTarget, setDropTarget] = useState<PaneDropTarget>(null);
  const dropTargetRef = useRef<PaneDropTarget>(null);
  const htabDropTargetRef = useRef<string | null>(null);
  // Dropped on the tab strip but not on any tab → detach into a new tab.
  const newHTabDropRef = useRef(false);
  // Dropped on a sidebar page row → new tab on that page.
  const nodeDropTargetRef = useRef<string | null>(null);

  const updateDropTarget = (next: PaneDropTarget) => {
    dropTargetRef.current = next;
    setDropTarget(next);
  };

  const startPaneDrag = (dragId: string, e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button,input")) return;
    e.preventDefault();

    const dragged = findLeaf(htab.layout, dragId);
    const ghost = createDragGhost(dragged?.title ?? "pane");
    ghost.move(e.clientX, e.clientY);
    const source = document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(dragId)}"]`);
    source?.classList.add("dragging");

    const clearTabHover = () => {
      document
        .querySelectorAll(".htab.pane-drop-target")
        .forEach((el) => el.classList.remove("pane-drop-target"));
      document
        .querySelectorAll(".htabbar.pane-drop-new")
        .forEach((el) => el.classList.remove("pane-drop-new"));
      document
        .querySelectorAll(".tree-row.tab-drop-target")
        .forEach((el) => el.classList.remove("tab-drop-target"));
    };

    const onMove = (ev: PointerEvent) => {
      clearTabHover();
      ghost.move(ev.clientX, ev.clientY);
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const tab = under?.closest<HTMLElement>("[data-htab-id]");
      const targetHTabId = tab?.dataset.htabId ?? null;
      if (tab && targetHTabId && targetHTabId !== htab.id) {
        htabDropTargetRef.current = targetHTabId;
        newHTabDropRef.current = false;
        nodeDropTargetRef.current = null;
        tab.classList.add("pane-drop-target");
        ghost.setHint(t("drag.toTab"));
        updateDropTarget(null);
        return;
      }
      htabDropTargetRef.current = null;

      // Over a sidebar page: the pane lands there as a new tab.
      const row = under?.closest<HTMLElement>("[data-tree-node-id]");
      const rowNodeId = row?.dataset.treeNodeId ?? null;
      if (row && rowNodeId) {
        nodeDropTargetRef.current = rowNodeId;
        newHTabDropRef.current = false;
        row.classList.add("tab-drop-target");
        ghost.setHint(t("drag.toPage"));
        updateDropTarget(null);
        return;
      }
      nodeDropTargetRef.current = null;

      // Over the strip itself (or its controls) but not over a tab: dropping
      // here pulls the pane out into a new tab.
      const bar = under?.closest<HTMLElement>(".htabbar");
      if (bar && !tab) {
        newHTabDropRef.current = true;
        bar.classList.add("pane-drop-new");
        ghost.setHint(t("drag.newTab"));
        updateDropTarget(null);
        return;
      }
      newHTabDropRef.current = false;

      const el = under?.closest<HTMLElement>("[data-pane-id]");
      const targetId = el?.dataset.paneId;
      if (!el || !targetId || targetId === dragId) {
        ghost.setHint(null);
        updateDropTarget(null);
        return;
      }
      const edge = edgeFor(el.getBoundingClientRect(), ev.clientX, ev.clientY);
      ghost.setHint(t(`drag.edge.${edge}`));
      updateDropTarget({ id: targetId, edge });
    };

    const onUp = () => {
      const target = dropTargetRef.current;
      const targetHTabId = htabDropTargetRef.current;
      const toNewHTab = newHTabDropRef.current;
      const targetNodeId = nodeDropTargetRef.current;
      htabDropTargetRef.current = null;
      newHTabDropRef.current = false;
      nodeDropTargetRef.current = null;
      updateDropTarget(null);
      clearTabHover();
      ghost.destroy();
      source?.classList.remove("dragging");
      endDragCursor();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (targetHTabId) {
        movePaneToHTab(dragId, targetHTabId);
        return;
      }
      if (targetNodeId) {
        movePaneToNode(dragId, targetNodeId);
        return;
      }
      if (toNewHTab) {
        movePaneToNewHTab(dragId);
        return;
      }
      if (target) movePane(dragId, target.id, target.edge);
    };

    beginDragCursor();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const maxLeaf = htab.maximized ? findLeaf(htab.layout, htab.maximized) : undefined;
  if (maxLeaf) {
    return (
      <PaneSlot
        leaf={maxLeaf}
        showFocus={false}
        solo
        dropTarget={dropTarget}
        onPaneDragStart={startPaneDrag}
      />
    );
  }
  return (
    <SplitTree
      pane={htab.layout}
      showFocus={paneCount(htab.layout) > 1}
      path={[]}
      dropTarget={dropTarget}
      onPaneDragStart={startPaneDrag}
    />
  );
}
