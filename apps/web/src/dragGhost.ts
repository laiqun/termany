/**
 * Shared drag feedback for the pointer-driven drags (pane → tab, tab → page,
 * page → page): the label that rides the cursor, plus the body-level cursor /
 * text-selection state every one of them needs.
 *
 * Deliberately imperative DOM rather than React state: the drag handlers in
 * SplitView/HTabBar/TreeSidebar already drive their hover affordances by
 * toggling classes, and re-rendering the whole tree on every pointermove would
 * be far worse.
 */

/**
 * Kill any selection the drag would otherwise smear across the UI.
 *
 * `user-select: none` alone is not enough. It stops a selection from being
 * ANCHORED in an element, but a selection anchored elsewhere still extends
 * across those elements as the pointer sweeps — which is why dragging a page
 * down the tree painted every row below it blue. The drags that wait for a
 * movement threshold also give the engine a few pixels to anchor one before
 * they engage. WKWebView (the desktop app) and Chromium differ here, so rather
 * than rely on either, we suppress it outright for the duration of the drag.
 */
const stopSelectStart = (e: Event) => e.preventDefault();
const dropSelection = () => {
  const sel = window.getSelection();
  // Guard the re-entry: removeAllRanges itself fires selectionchange.
  if (sel && !sel.isCollapsed) sel.removeAllRanges();
};

/** Enter "dragging" mode: grab cursor, no text selection. */
export function beginDragCursor() {
  document.body.style.cursor = "grabbing";
  document.body.style.userSelect = "none";
  dropSelection();
  document.addEventListener("selectstart", stopSelectStart);
  document.addEventListener("selectionchange", dropSelection);
}

/** Undo beginDragCursor. Safe to call even if the drag never engaged. */
export function endDragCursor() {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  document.removeEventListener("selectstart", stopSelectStart);
  document.removeEventListener("selectionchange", dropSelection);
}
export interface DragGhost {
  /** Reposition to the current pointer location. */
  move: (x: number, y: number) => void;
  /** Swap the trailing hint, e.g. "→ new tab". Pass null to clear it. */
  setHint: (hint: string | null) => void;
  /** Remove from the DOM. Safe to call twice. */
  destroy: () => void;
}

export function createDragGhost(label: string, icon?: string): DragGhost {
  const el = document.createElement("div");
  el.className = "drag-ghost";

  if (icon) {
    const i = document.createElement("span");
    i.className = "drag-ghost-icon";
    i.textContent = icon;
    el.append(i);
  }
  const name = document.createElement("span");
  name.className = "drag-ghost-label";
  name.textContent = label;
  el.append(name);

  const hintEl = document.createElement("span");
  hintEl.className = "drag-ghost-hint";
  el.append(hintEl);

  document.body.append(el);

  return {
    move: (x, y) => {
      el.style.transform = `translate(${x}px, ${y}px)`;
    },
    setHint: (hint) => {
      hintEl.textContent = hint ?? "";
      el.classList.toggle("has-hint", !!hint);
    },
    destroy: () => el.remove(),
  };
}
