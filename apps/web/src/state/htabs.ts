import type { HTab, TreeNode } from "./store";

/**
 * Remove every tab whose cwd satisfies `match`, from every page in the tree.
 * Pure: returns the new tree plus the removed tabs — disposing their sessions
 * is the caller's job. A page left with no tabs gets `refill()`, keeping the
 * every-page-has-a-tab invariant the same way closing the last tab by hand
 * does. Used when a directory goes away (a worktree is deleted) and the tabs
 * pointed at it would otherwise sit on a path that no longer exists.
 */
export function closeMatchingHTabs(
  nodes: TreeNode[],
  match: (cwd: string) => boolean,
  refill: () => HTab,
): { nodes: TreeNode[]; closed: HTab[] } {
  const closed: HTab[] = [];
  const walk = (list: TreeNode[]): TreeNode[] =>
    list.map((n) => {
      const children = n.children.length ? walk(n.children) : n.children;
      const kept = n.htabs.filter((h) => !(h.cwd && match(h.cwd)));
      if (kept.length === n.htabs.length) return children === n.children ? n : { ...n, children };
      closed.push(...n.htabs.filter((h) => !kept.includes(h)));
      let htabs = kept;
      let activeHTab = n.activeHTab;
      if (htabs.length === 0) {
        const fresh = refill();
        htabs = [fresh];
        activeHTab = fresh.id;
      } else if (!htabs.some((h) => h.id === activeHTab)) {
        activeHTab = htabs[htabs.length - 1].id;
      }
      return { ...n, htabs, activeHTab, children };
    });
  return { nodes: walk(nodes), closed };
}
