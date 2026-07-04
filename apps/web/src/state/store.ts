import { create } from "zustand";
import {
  type Chord,
  DEFAULT_KEYBINDINGS,
  loadKeybindings,
  saveKeybindings,
} from "../keybindings";
import { disposeSession, inheritSessionCwd } from "../terminal/manager";
import { applyTheme, loadThemeId, THEMES } from "../themes";

/**
 * Notion-style model:
 *
 *   Workspace            (icon rail, far left)
 *     └─ TreeNode        (sidebar — an INFINITELY nestable page/folder)
 *          ├─ TreeNode   (children, any depth)
 *          └─ HTab[]     (every node owns its own terminal tabs)
 *
 * Every node is clickable: selecting it drives the right-hand panel (its HTabs).
 * A node is simultaneously a "page" (has terminals) and a "folder" (has children),
 * exactly like a Notion page.
 */

/**
 * A pane layout inside a tab: either a single terminal (leaf) or a row/col split
 * of child panes. `dir: "row"` = side by side (vertical divider, ⌘D);
 * `dir: "col"` = stacked top/bottom (horizontal divider, ⌘⇧D).
 *
 * A leaf's `id` is the terminal session id in the registry.
 */
export type Pane =
  | { kind: "leaf"; id: string; title: string }
  | {
      kind: "split";
      dir: "row" | "col";
      children: Pane[];
      /**
       * Each child's fractional size (sums to 1, length === children.length).
       * Omitted means "evenly sized"; resizeSplit fills it in on first drag.
       * Cleared whenever children are added/removed so it can't go stale.
       */
      sizes?: number[];
    };

/** Which side of a target pane a drag is dropping onto. */
export type DropEdge = "left" | "right" | "top" | "bottom";

/**
 * DataTransfer MIME for dragging a whole terminal tab onto a tree page.
 * Payload is JSON: `{ tabId, nodeId }` (the tab and the page it came from).
 * Distinct from the tree-node MIME so a page-drag and a tab-drag never collide.
 */
export const HTAB_DRAG_MIME = "application/x-termany-htab";

export interface HTab {
  id: string;
  title: string;
  layout: Pane;
  /** The focused leaf (session id) — where split/close act and keyboard goes. */
  focused: string;
  /** When set, only this leaf is shown, filling the tab (Wave-style magnify). */
  maximized?: string;
}

export interface TreeNode {
  id: string;
  title: string;
  expanded: boolean;
  children: TreeNode[];
  htabs: HTab[];
  activeHTab: string;
}

export interface Workspace {
  id: string;
  title: string;
  /** Emoji icon; when unset the UI falls back to the title's first letter. */
  icon?: string;
  roots: TreeNode[];
  activeNode: string;
}

interface State {
  workspaces: Workspace[];
  activeWorkspace: string;

  /** Active theme id (see themes.ts). Persisted to localStorage. */
  theme: string;
  setTheme: (id: string) => void;
  nextTheme: () => void;
  prevTheme: () => void;

  /** Whether the left sidebar is hidden. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  /** Version of an available desktop update (badges + About), or null. */
  updateVersion: string | null;
  setUpdateVersion: (v: string | null) => void;

  /** Action id → key chord. Persisted to localStorage. */
  keybindings: Record<string, Chord>;
  /** Rebind one action. Pass null to restore that action's default. */
  setKeybinding: (actionId: string, chord: Chord | null) => void;
  /** Restore every shortcut to its default. */
  resetKeybindings: () => void;

  addWorkspace: (init?: { title?: string; icon?: string }) => void;
  setActiveWorkspace: (id: string) => void;
  /** Activate the next / previous workspace (wraps around). */
  nextWorkspace: () => void;
  prevWorkspace: () => void;
  renameWorkspace: (id: string, title: string) => void;
  /** Set the workspace's emoji icon, or null to revert to the letter avatar. */
  setWorkspaceIcon: (id: string, icon: string | null) => void;

  addRootNode: () => void;
  addChildNode: (parentId: string) => void;
  toggleExpand: (id: string) => void;
  /** Collapse every node in the active workspace's tree. */
  collapseAll: () => void;
  setActiveNode: (id: string) => void;
  renameNode: (id: string, title: string) => void;
  deleteNode: (id: string) => void;
  /**
   * Move a node relative to `targetId`: "into" nests it as the last child
   * (default), "before"/"after" reorder it as a sibling. `null` target moves
   * it to the end of the root level.
   */
  moveNode: (dragId: string, targetId: string | null, pos?: "into" | "before" | "after") => void;

  addHTab: () => void;
  setActiveHTab: (id: string) => void;
  closeHTab: (id: string) => void;
  renameHTab: (id: string, title: string) => void;
  /**
   * Move a whole tab from one page to another (drag tab → tree page). The
   * terminal sessions live outside React keyed by id, so this just relocates the
   * HTab object — the shells keep running. Refills the source page with a fresh
   * blank tab if it would otherwise be left with none.
   */
  moveHTab: (tabId: string, fromNodeId: string, toNodeId: string) => void;

  /** Split the focused pane of the active tab in the given direction. */
  splitFocused: (dir: "row" | "col") => void;
  /** Close the focused pane; closes the whole tab if it was the last pane. */
  closeFocusedPane: () => void;
  setFocusedPane: (leafId: string) => void;
  renamePane: (leafId: string, title: string) => void;
  /** Close a specific pane; closes the whole tab if it was the last pane. */
  closePane: (leafId: string) => void;
  /** Toggle magnify on a pane (show it alone, filling the tab). */
  toggleMaximize: (leafId: string) => void;
  /** Drag-rearrange: move `dragId` to the given edge of `targetId`. */
  movePane: (dragId: string, targetId: string, edge: DropEdge) => void;
  /** Set the child fractions of the split node at `path` (child-index trail). */
  resizeSplit: (path: number[], sizes: number[]) => void;
}

const id = () => crypto.randomUUID();

function makeLeaf(title = "terminal"): Pane & { kind: "leaf" } {
  return { kind: "leaf", id: id(), title };
}

function makeHTab(n: number): HTab {
  const leaf = makeLeaf();
  return { id: id(), title: `tab ${n}`, layout: leaf, focused: leaf.id };
}

// --- pane layout helpers ---------------------------------------------------

function leafIds(pane: Pane): string[] {
  return pane.kind === "leaf" ? [pane.id] : pane.children.flatMap(leafIds);
}

function firstLeaf(pane: Pane): string {
  return pane.kind === "leaf" ? pane.id : firstLeaf(pane.children[0]);
}

function findLeaf(pane: Pane, leafId: string): (Pane & { kind: "leaf" }) | undefined {
  if (pane.kind === "leaf") return pane.id === leafId ? pane : undefined;
  for (const c of pane.children) {
    const hit = findLeaf(c, leafId);
    if (hit) return hit;
  }
  return undefined;
}

/** Insert `leaf` beside `targetId` on the given edge; merges into same-dir parents. */
function insertBeside(pane: Pane, targetId: string, leaf: Pane, edge: DropEdge): Pane {
  const dir: "row" | "col" = edge === "left" || edge === "right" ? "row" : "col";
  const before = edge === "left" || edge === "top";
  if (pane.kind === "leaf") {
    if (pane.id !== targetId) return pane;
    return { kind: "split", dir, children: before ? [leaf, pane] : [pane, leaf] };
  }
  if (pane.dir === dir) {
    const idx = pane.children.findIndex((c) => c.kind === "leaf" && c.id === targetId);
    if (idx >= 0) {
      const children = [...pane.children];
      children.splice(before ? idx : idx + 1, 0, leaf);
      return { ...pane, children, sizes: undefined }; // child count changed → re-even
    }
  }
  return { ...pane, children: pane.children.map((c) => insertBeside(c, targetId, leaf, edge)) };
}

/** Split `targetId` in `dir`; merges into a same-direction parent for clean grids. */
function splitPane(pane: Pane, targetId: string, dir: "row" | "col", newLeaf: Pane): Pane {
  if (pane.kind === "leaf") {
    if (pane.id !== targetId) return pane;
    return { kind: "split", dir, children: [pane, newLeaf] };
  }
  if (pane.dir === dir) {
    const idx = pane.children.findIndex((c) => c.kind === "leaf" && c.id === targetId);
    if (idx >= 0) {
      const children = [...pane.children];
      children.splice(idx + 1, 0, newLeaf);
      return { ...pane, children, sizes: undefined }; // child count changed → re-even
    }
  }
  return { ...pane, children: pane.children.map((c) => splitPane(c, targetId, dir, newLeaf)) };
}

/** Remove a leaf; collapses splits that drop to a single child. Null = empty. */
function removeLeaf(pane: Pane, leafId: string): Pane | null {
  if (pane.kind === "leaf") return pane.id === leafId ? null : pane;
  const children = pane.children
    .map((c) => removeLeaf(c, leafId))
    .filter((c): c is Pane => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const sizes = children.length === pane.children.length ? pane.sizes : undefined;
  return { ...pane, children, sizes }; // re-even only if a child actually dropped
}

/** Set `sizes` on the split node reached by following `path` (child indices). */
function setSizesAt(pane: Pane, path: number[], sizes: number[]): Pane {
  if (pane.kind !== "split") return pane;
  if (path.length === 0) return { ...pane, sizes };
  const [i, ...rest] = path;
  return {
    ...pane,
    children: pane.children.map((c, idx) => (idx === i ? setSizesAt(c, rest, sizes) : c)),
  };
}

function makeNode(title: string): TreeNode {
  const h = makeHTab(1);
  return { id: id(), title, expanded: true, children: [], htabs: [h], activeHTab: h.id };
}

function initialWorkspace(title: string): Workspace {
  const root = makeNode("page 1");
  return { id: id(), title, roots: [root], activeNode: root.id };
}

// --- immutable tree helpers ------------------------------------------------

/** Return a new tree with `fn` applied to the node matching `id`. */
function updateNode(
  nodes: TreeNode[],
  nodeId: string,
  fn: (n: TreeNode) => TreeNode
): TreeNode[] {
  return nodes.map((n) => {
    if (n.id === nodeId) return fn(n);
    if (n.children.length) {
      const children = updateNode(n.children, nodeId, fn);
      if (children !== n.children) return { ...n, children };
    }
    return n;
  });
}

function insertChild(nodes: TreeNode[], parentId: string, child: TreeNode): TreeNode[] {
  return updateNode(nodes, parentId, (n) => ({
    ...n,
    expanded: true,
    children: [...n.children, child],
  }));
}

function removeNode(nodes: TreeNode[], nodeId: string): TreeNode[] {
  return nodes
    .filter((n) => n.id !== nodeId)
    .map((n) => (n.children.length ? { ...n, children: removeNode(n.children, nodeId) } : n));
}

/** Insert `node` as a SIBLING of `targetId`, directly before or after it. */
function insertSibling(
  nodes: TreeNode[],
  targetId: string,
  node: TreeNode,
  after: boolean
): TreeNode[] {
  const i = nodes.findIndex((n) => n.id === targetId);
  if (i >= 0) {
    const out = [...nodes];
    out.splice(after ? i + 1 : i, 0, node);
    return out;
  }
  return nodes.map((n) =>
    n.children.length ? { ...n, children: insertSibling(n.children, targetId, node, after) } : n
  );
}

function findNode(nodes: TreeNode[], nodeId: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.id === nodeId) return n;
    const hit = findNode(n.children, nodeId);
    if (hit) return hit;
  }
  return undefined;
}

/** Every terminal session id under a node (incl. descendants) — for cleanup. */
function subtreeLeafIds(node: TreeNode): string[] {
  return [
    ...node.htabs.flatMap((h) => leafIds(h.layout)),
    ...node.children.flatMap(subtreeLeafIds),
  ];
}

// --- store -----------------------------------------------------------------

const first = initialWorkspace("ws 1");

/** Map only the active workspace; pass others through untouched. */
function inActiveWs(s: State, fn: (ws: Workspace) => Workspace): Workspace[] {
  return s.workspaces.map((ws) => (ws.id === s.activeWorkspace ? fn(ws) : ws));
}

/** Close one leaf in the active tab; drops the whole tab if it was the last pane. */
function closeLeaf(s: State, leafId: string): Partial<State> {
  const node = activeNode(s);
  const htab = node?.htabs.find((h) => h.id === node.activeHTab);
  if (!node || !htab) return {};
  disposeSession(leafId);
  const layout = removeLeaf(htab.layout, leafId);
  return {
    workspaces: inActiveWs(s, (ws) => ({
      ...ws,
      roots: updateNode(ws.roots, ws.activeNode, (n) => {
        if (layout === null) {
          const htabs = n.htabs.filter((h) => h.id !== htab.id);
          if (htabs.length === 0) {
            const h = makeHTab(1);
            return { ...n, htabs: [h], activeHTab: h.id };
          }
          const activeHTab = n.activeHTab === htab.id ? htabs[htabs.length - 1].id : n.activeHTab;
          return { ...n, htabs, activeHTab };
        }
        return {
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== htab.id) return h;
            return {
              ...h,
              layout,
              focused: h.focused === leafId ? firstLeaf(layout) : h.focused,
              maximized: h.maximized === leafId ? undefined : h.maximized,
            };
          }),
        };
      }),
    })),
  };
}

export const useStore = create<State>((set) => ({
  workspaces: [first],
  activeWorkspace: first.id,

  theme: loadThemeId(),
  setTheme: (id) => {
    applyTheme(id);
    set({ theme: id });
  },
  nextTheme: () =>
    set((s) => {
      const i = THEMES.findIndex((t) => t.id === s.theme);
      const next = THEMES[(i + 1 + THEMES.length) % THEMES.length];
      applyTheme(next.id);
      return { theme: next.id };
    }),
  prevTheme: () =>
    set((s) => {
      const i = THEMES.findIndex((t) => t.id === s.theme);
      const prev = THEMES[(i - 1 + THEMES.length) % THEMES.length];
      applyTheme(prev.id);
      return { theme: prev.id };
    }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  updateVersion: null,
  setUpdateVersion: (v) => set({ updateVersion: v }),

  keybindings: loadKeybindings(),
  setKeybinding: (actionId, chord) =>
    set((s) => {
      const next = { ...s.keybindings, [actionId]: chord ?? DEFAULT_KEYBINDINGS[actionId] };
      saveKeybindings(next);
      return { keybindings: next };
    }),
  resetKeybindings: () =>
    set(() => {
      const next = { ...DEFAULT_KEYBINDINGS };
      saveKeybindings(next);
      return { keybindings: next };
    }),

  addWorkspace: (init) =>
    set((s) => {
      const ws = initialWorkspace(init?.title?.trim() || `ws ${s.workspaces.length + 1}`);
      if (init?.icon) ws.icon = init.icon;
      return { workspaces: [...s.workspaces, ws], activeWorkspace: ws.id };
    }),

  setActiveWorkspace: (wsId) => set({ activeWorkspace: wsId }),

  nextWorkspace: () =>
    set((s) => {
      const i = s.workspaces.findIndex((w) => w.id === s.activeWorkspace);
      return { activeWorkspace: s.workspaces[(i + 1) % s.workspaces.length].id };
    }),

  prevWorkspace: () =>
    set((s) => {
      const len = s.workspaces.length;
      const i = s.workspaces.findIndex((w) => w.id === s.activeWorkspace);
      return { activeWorkspace: s.workspaces[(i - 1 + len) % len].id };
    }),

  renameWorkspace: (wsId, title) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === wsId ? { ...w, title } : w)),
    })),

  setWorkspaceIcon: (wsId, icon) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === wsId ? { ...w, icon: icon ?? undefined } : w)),
    })),

  addRootNode: () =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => {
        const node = makeNode(`page ${ws.roots.length + 1}`);
        return { ...ws, roots: [...ws.roots, node], activeNode: node.id };
      }),
    })),

  addChildNode: (parentId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => {
        const child = makeNode("untitled");
        return { ...ws, roots: insertChild(ws.roots, parentId, child), activeNode: child.id };
      }),
    })),

  toggleExpand: (nodeId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, nodeId, (n) => ({ ...n, expanded: !n.expanded })),
      })),
    })),

  collapseAll: () =>
    set((s) => {
      const collapse = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((n) => ({ ...n, expanded: false, children: collapse(n.children) }));
      return { workspaces: inActiveWs(s, (ws) => ({ ...ws, roots: collapse(ws.roots) })) };
    }),

  setActiveNode: (nodeId) =>
    set((s) => ({ workspaces: inActiveWs(s, (ws) => ({ ...ws, activeNode: nodeId })) })),

  renameNode: (nodeId, title) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, nodeId, (n) => ({ ...n, title })),
      })),
    })),

  deleteNode: (nodeId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => {
        const target = findNode(ws.roots, nodeId);
        if (!target) return ws;
        subtreeLeafIds(target).forEach(disposeSession);
        let roots = removeNode(ws.roots, nodeId);
        if (roots.length === 0) roots = [makeNode("page 1")];
        const activeNode = findNode(roots, ws.activeNode) ? ws.activeNode : roots[0].id;
        return { ...ws, roots, activeNode };
      }),
    })),

  moveNode: (dragId, targetId, pos = "into") =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => {
        if (dragId === targetId) return ws;
        const dragged = findNode(ws.roots, dragId);
        if (!dragged) return ws;
        // Can't drop a node into itself or one of its own descendants.
        if (targetId && findNode([dragged], targetId)) return ws;
        const without = removeNode(ws.roots, dragId);
        const roots = !targetId
          ? [...without, dragged]
          : pos === "into"
            ? insertChild(without, targetId, dragged)
            : insertSibling(without, targetId, dragged, pos === "after");
        return { ...ws, roots };
      }),
    })),

  addHTab: () =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, ws.activeNode, (n) => {
          const h = makeHTab(n.htabs.length + 1);
          return { ...n, htabs: [...n.htabs, h], activeHTab: h.id };
        }),
      })),
    })),

  setActiveHTab: (hId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, ws.activeNode, (n) => ({ ...n, activeHTab: hId })),
      })),
    })),

  renameHTab: (hId, title) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, ws.activeNode, (n) => ({
          ...n,
          htabs: n.htabs.map((h) => (h.id === hId ? { ...h, title } : h)),
        })),
      })),
    })),

  closeHTab: (hId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, ws.activeNode, (n) => {
          const target = n.htabs.find((h) => h.id === hId);
          if (target) leafIds(target.layout).forEach(disposeSession);
          const htabs = n.htabs.filter((h) => h.id !== hId);
          if (htabs.length === 0) {
            const h = makeHTab(1);
            return { ...n, htabs: [h], activeHTab: h.id };
          }
          const activeHTab = n.activeHTab === hId ? htabs[htabs.length - 1].id : n.activeHTab;
          return { ...n, htabs, activeHTab };
        }),
      })),
    })),

  moveHTab: (tabId, fromNodeId, toNodeId) =>
    set((s) => {
      if (fromNodeId === toNodeId) return {};
      return {
        workspaces: inActiveWs(s, (ws) => {
          const from = findNode(ws.roots, fromNodeId);
          const moving = from?.htabs.find((h) => h.id === tabId);
          if (!moving || !findNode(ws.roots, toNodeId)) return ws;
          // Pull the tab out of its source page (refill to keep every page ≥1 tab).
          let roots = updateNode(ws.roots, fromNodeId, (n) => {
            const htabs = n.htabs.filter((h) => h.id !== tabId);
            if (htabs.length === 0) {
              const h = makeHTab(1);
              return { ...n, htabs: [h], activeHTab: h.id };
            }
            const activeHTab =
              n.activeHTab === tabId ? htabs[htabs.length - 1].id : n.activeHTab;
            return { ...n, htabs, activeHTab };
          });
          // Append to the target page, focus it there, and FOLLOW the tab:
          // after the drop the user lands on the target page with the moved
          // tab active, instead of staying on the source page.
          roots = updateNode(roots, toNodeId, (n) => ({
            ...n,
            htabs: [...n.htabs, moving],
            activeHTab: moving.id,
          }));
          return { ...ws, roots, activeNode: toNodeId };
        }),
      };
    }),

  splitFocused: (dir) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, ws.activeNode, (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            const leaf = makeLeaf();
            inheritSessionCwd(leaf.id, h.focused);
            return {
              ...h,
              layout: splitPane(h.layout, h.focused, dir, leaf),
              focused: leaf.id,
              maximized: undefined,
            };
          }),
        })),
      })),
    })),

  closeFocusedPane: () =>
    set((s) => {
      const h = activeHtab(s);
      return h ? closeLeaf(s, h.focused) : {};
    }),

  closePane: (leafId) => set((s) => closeLeaf(s, leafId)),

  setFocusedPane: (leafId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, ws.activeNode, (n) => ({
          ...n,
          htabs: n.htabs.map((h) => (h.id === n.activeHTab ? { ...h, focused: leafId } : h)),
        })),
      })),
    })),

  renamePane: (leafId, title) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, ws.activeNode, (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab) return h;
            const rename = (p: Pane): Pane =>
              p.kind === "leaf"
                ? p.id === leafId
                  ? { ...p, title }
                  : p
                : { ...p, children: p.children.map(rename) };
            return { ...h, layout: rename(h.layout) };
          }),
        })),
      })),
    })),

  toggleMaximize: (leafId) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, ws.activeNode, (n) => ({
          ...n,
          htabs: n.htabs.map((h) =>
            h.id === n.activeHTab
              ? { ...h, maximized: h.maximized === leafId ? undefined : leafId, focused: leafId }
              : h
          ),
        })),
      })),
    })),

  movePane: (dragId, targetId, edge) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, ws.activeNode, (n) => ({
          ...n,
          htabs: n.htabs.map((h) => {
            if (h.id !== n.activeHTab || dragId === targetId) return h;
            const dragged = findLeaf(h.layout, dragId);
            if (!dragged) return h;
            const without = removeLeaf(h.layout, dragId);
            if (!without || !findLeaf(without, targetId)) return h;
            return {
              ...h,
              layout: insertBeside(without, targetId, dragged, edge),
              focused: dragId,
              maximized: undefined,
            };
          }),
        })),
      })),
    })),

  resizeSplit: (path, sizes) =>
    set((s) => ({
      workspaces: inActiveWs(s, (ws) => ({
        ...ws,
        roots: updateNode(ws.roots, ws.activeNode, (n) => ({
          ...n,
          htabs: n.htabs.map((h) =>
            h.id === n.activeHTab ? { ...h, layout: setSizesAt(h.layout, path, sizes) } : h
          ),
        })),
      })),
    })),
}));

// Selectors -----------------------------------------------------------------

export function activeWorkspace(s: State): Workspace {
  return s.workspaces.find((w) => w.id === s.activeWorkspace) ?? s.workspaces[0];
}

export function activeNode(s: State): TreeNode | undefined {
  const ws = activeWorkspace(s);
  return findNode(ws.roots, ws.activeNode);
}

export function activeHtab(s: State): HTab | undefined {
  const node = activeNode(s);
  return node?.htabs.find((h) => h.id === node.activeHTab);
}

export function paneCount(pane: Pane): number {
  return leafIds(pane).length;
}
