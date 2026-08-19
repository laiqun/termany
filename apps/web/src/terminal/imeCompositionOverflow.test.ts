import assert from "node:assert/strict";
import test from "node:test";
import { fixImeCompositionOverflow } from "./imeCompositionOverflow";

function makeFakeTerm() {
  const view = {
    style: {} as Record<string, string>,
    textContent: "",
  };
  const helper = {
    _compositionView: view,
    _isComposing: true,
    get isComposing() {
      return this._isComposing;
    },
    compositionupdateCalls: [] as Array<Pick<CompositionEvent, "data">>,
    compositionupdate(ev: Pick<CompositionEvent, "data">) {
      this.compositionupdateCalls.push(ev);
      view.textContent = ev.data ?? "";
    },
    updateCompositionElementsCalls: [] as Array<boolean | undefined>,
    updateCompositionElements(dontRecurse?: boolean) {
      this.updateCompositionElementsCalls.push(dontRecurse);
    },
  };
  const term = {
    _core: {
      _compositionHelper: helper,
      _renderService: {
        dimensions: {
          css: {
            cell: { width: 10, height: 20 },
          },
        },
      },
      _bufferService: {
        buffer: {
          x: 7,
          cols: 10,
        },
      },
    },
  };
  return { term, helper, view };
}

test("compositionupdate wraps pre-edit text in LTR marks", () => {
  const { term, helper } = makeFakeTerm();
  fixImeCompositionOverflow(term as any);

  (helper as any).compositionupdate({ data: "pinyin" });
  assert.equal(helper.compositionupdateCalls.length, 1);
  assert.equal(helper.compositionupdateCalls[0].data, "\u200Epinyin\u200E");
});

test("updateCompositionElements caps width to the remaining terminal space", () => {
  const { term, helper, view } = makeFakeTerm();
  fixImeCompositionOverflow(term as any);

  (helper as any).updateCompositionElements(false);
  assert.deepEqual(helper.updateCompositionElementsCalls, [false]);
  // cols=10, cursor x=7 -> 3 cells remain; cell width=10 -> max-width=30px.
  assert.equal(view.style.maxWidth, "30px");
  assert.equal(view.style.overflow, "hidden");
  assert.equal(view.style.direction, "rtl");
});

test("updateCompositionElements tolerates a missing composition view", () => {
  const { term, helper } = makeFakeTerm();
  helper._compositionView = undefined as any;
  // Should not throw.
  fixImeCompositionOverflow(term as any);
});

test("updateCompositionElements is a no-op when xterm internals are absent", () => {
  const term = { _core: {} };
  // Should not throw.
  fixImeCompositionOverflow(term as any);
});
