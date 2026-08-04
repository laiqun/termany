import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextFocusAfterClose } from "../src/state/paneFocus";
import type { Pane } from "../src/state/store";

const leaf = (id: string): Pane => ({ kind: "leaf", id, title: id });
const row = (...children: Pane[]): Pane => ({ kind: "split", dir: "row", children });
const col = (...children: Pane[]): Pane => ({ kind: "split", dir: "col", children });

describe("nextFocusAfterClose", () => {
  it("hands focus to the pane after the closed one", () => {
    assert.equal(nextFocusAfterClose(row(leaf("a"), leaf("b"), leaf("c")), "b"), "c");
  });

  it("falls back to the pane before it when the closed pane was last", () => {
    assert.equal(nextFocusAfterClose(row(leaf("a"), leaf("b"), leaf("c")), "c"), "b");
  });

  it("stays inside the split that held the closed pane", () => {
    // row[ a , col[b, c] ] — closing c must land on b, its own sibling, and
    // not jump across the tab to a.
    assert.equal(nextFocusAfterClose(row(leaf("a"), col(leaf("b"), leaf("c"))), "c"), "b");
  });

  it("picks the nearest edge of a neighbouring subtree, not its first leaf", () => {
    // row[ col[a, b] , c ] — closing c grows the left column, whose visually
    // nearest pane is b (its bottom), not a.
    assert.equal(nextFocusAfterClose(row(col(leaf("a"), leaf("b")), leaf("c")), "c"), "b");
  });

  it("enters the next subtree at its first leaf", () => {
    assert.equal(nextFocusAfterClose(row(leaf("a"), col(leaf("b"), leaf("c"))), "a"), "b");
  });

  it("never returns the pane being closed", () => {
    const layout = row(leaf("a"), col(leaf("b"), leaf("c")), leaf("d"));
    for (const id of ["a", "b", "c", "d"]) {
      assert.notEqual(nextFocusAfterClose(layout, id), id);
    }
  });

  it("returns null when the closed pane was the only one", () => {
    assert.equal(nextFocusAfterClose(leaf("a"), "a"), null);
  });

  it("returns null for a pane that is not in the layout", () => {
    assert.equal(nextFocusAfterClose(row(leaf("a"), leaf("b")), "zzz"), null);
  });
});
