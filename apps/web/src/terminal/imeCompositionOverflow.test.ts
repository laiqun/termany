import assert from "node:assert/strict";
import test from "node:test";
import { fixImeCompositionOverflow } from "./imeCompositionOverflow";

function makeFakeTerm() {
  const view = {
    style: {} as Record<string, string>,
    textContent: "",
  };
  const textarea = {
    style: {} as Record<string, string>,
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
  const renderListeners = new Set<() => void>();
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
    textarea,
    element: { clientWidth: 100 } as HTMLElement,
    onRender(cb: () => void) {
      renderListeners.add(cb);
      return { dispose: () => renderListeners.delete(cb) };
    },
    fireRender() {
      for (const cb of renderListeners) cb();
    },
  };
  return { term, helper, view, textarea, fireRender: term.fireRender };
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

test("render fallback clamps an oversized composition view and textarea", () => {
  const { term, helper, view, textarea, fireRender } = makeFakeTerm();
  fixImeCompositionOverflow(term as any);

  // Simulate xterm positioning the view near the right edge.
  view.style.left = "80px";
  view.textContent = "abc";
  textarea.style.width = "200px";
  fireRender();

  // host.clientWidth=100, view left=80 -> remaining width=20.
  assert.equal(view.style.maxWidth, "20px");
  assert.equal(view.style.direction, "rtl");
  assert.equal(view.textContent, "\u200Eabc\u200E");
  assert.equal(textarea.style.width, "20px");
  assert.equal(textarea.style.maxWidth, "20px");
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
