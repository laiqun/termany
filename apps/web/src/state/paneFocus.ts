/**
 * Which pane takes the focus ring when another one closes.
 *
 * Closing used to hand focus to the tab's very first leaf, which is almost
 * never where the user was looking — close the bottom-right pane of a grid and
 * the ring jumped to the top-left corner. The neighbour is the pane that
 * visually GROWS into the freed space, so that is the one that gets focus.
 *
 * Kept free of runtime imports so it can be exercised directly.
 */
import type { Pane } from "./store";

function firstLeaf(pane: Pane): string {
  return pane.kind === "leaf" ? pane.id : firstLeaf(pane.children[0]);
}

function lastLeaf(pane: Pane): string {
  return pane.kind === "leaf" ? pane.id : lastLeaf(pane.children[pane.children.length - 1]);
}

/**
 * The leaf that should hold focus once `leafId` is removed from `layout`:
 * its nearest sibling in the split that held it — the one after it, else the
 * one before. Descending a sibling subtree enters it from the touching edge
 * (the next one's first leaf, the previous one's last), so focus lands on the
 * pane that was physically adjacent rather than that subtree's corner.
 *
 * `null` when there is no neighbour to pick: the closed pane was the whole
 * layout, or it isn't in this layout at all. Callers keep their own fallback.
 *
 * Pass the layout as it was BEFORE the removal — the siblings are what makes
 * the choice.
 */
export function nextFocusAfterClose(layout: Pane, leafId: string): string | null {
  if (layout.kind === "leaf") return null;

  const i = layout.children.findIndex((c) => c.kind === "leaf" && c.id === leafId);
  if (i >= 0) {
    const after = layout.children[i + 1];
    if (after) return firstLeaf(after);
    const before = layout.children[i - 1];
    if (before) return lastLeaf(before);
    return null; // a one-child split shouldn't exist, but don't invent a pane
  }

  for (const child of layout.children) {
    const hit = nextFocusAfterClose(child, leafId);
    if (hit) return hit;
  }
  return null;
}
