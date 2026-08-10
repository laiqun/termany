import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeMatchingHTabs } from "../src/state/htabs";
import type { HTab, Pane, TreeNode } from "../src/state/store";

let seq = 0;
const leaf = (): Pane => ({ kind: "leaf", id: `leaf-${++seq}`, title: "pane" });
const tab = (id: string, cwd?: string): HTab => {
  const l = leaf();
  return { id, title: id, layout: l, focused: l.id as string, cwd };
};
const page = (id: string, htabs: HTab[], activeHTab = "", children: TreeNode[] = []): TreeNode => ({
  id,
  title: id,
  expanded: true,
  children,
  htabs,
  activeHTab: activeHTab || htabs[0]?.id || "",
});

let refillSeq = 0;
const refill = (): HTab => tab(`refill-${++refillSeq}`);

const inRepo = (cwd: string) => cwd === "/repo" || cwd.startsWith("/repo/");

describe("closeMatchingHTabs", () => {
  it("closes matching tabs across nested pages and reports them", () => {
    const keep = tab("keep", "/elsewhere");
    const dead1 = tab("dead1", "/repo");
    const dead2 = tab("dead2", "/repo/sub");
    const child = page("child", [dead2]);
    const roots = [page("p1", [keep, dead1], keep.id, [child])];

    const { nodes, closed } = closeMatchingHTabs(roots, inRepo, refill);

    assert.deepEqual(
      closed.map((h) => h.id).sort(),
      ["dead1", "dead2"],
    );
    assert.deepEqual(
      nodes[0].htabs.map((h) => h.id),
      ["keep"],
    );
    assert.equal(nodes[0].activeHTab, "keep");
    // The emptied child page got a refill tab and points at it.
    assert.equal(nodes[0].children[0].htabs.length, 1);
    assert.match(nodes[0].children[0].htabs[0].id, /^refill-/);
    assert.equal(nodes[0].children[0].activeHTab, nodes[0].children[0].htabs[0].id);
  });

  it("keeps cwd-less (home) tabs and tabs outside the directory", () => {
    const home = tab("home");
    const sibling = tab("sibling", "/repo-other");
    const roots = [page("p1", [home, sibling])];

    const { nodes, closed } = closeMatchingHTabs(roots, inRepo, refill);

    assert.equal(closed.length, 0);
    assert.deepEqual(
      nodes[0].htabs.map((h) => h.id),
      ["home", "sibling"],
    );
  });

  it("moves the active pointer to the last remaining tab when its tab closes", () => {
    const a = tab("a", "/elsewhere");
    const b = tab("b", "/repo");
    const roots = [page("p1", [a, b], b.id)];

    const { nodes } = closeMatchingHTabs(roots, inRepo, refill);

    assert.equal(nodes[0].activeHTab, "a");
  });

  it("returns the same node objects when nothing matches", () => {
    const a = tab("a", "/elsewhere");
    const roots = [page("p1", [a])];

    const { nodes, closed } = closeMatchingHTabs(roots, inRepo, refill);

    assert.equal(closed.length, 0);
    assert.equal(nodes[0], roots[0]);
  });
});
