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
    compositionstartCalls: [] as void[],
    compositionstart() {
      this.compositionstartCalls.push();
    },
    compositionendCalls: [] as void[],
    compositionend() {
      this.compositionendCalls.push();
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
        rows: 5,
        buffer: {
          x: 7,
          y: 2,
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
  const { term, view, textarea, fireRender } = makeFakeTerm();
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

test("compositionstart pins the overlay to the starting cursor cell", () => {
  const { term, helper, view, textarea } = makeFakeTerm();
  fixImeCompositionOverflow(term as any);

  // cursor starts at buffer.x = 7, buffer.y = 2.
  // cell width = 10, cell height = 20 -> anchor left = 70px, top = 40px.
  (helper as any).compositionstart();
  (helper as any).updateCompositionElements(false);

  assert.equal(view.style.left, "70px");
  assert.equal(textarea.style.left, "70px");
  assert.equal(view.style.top, "40px");
  assert.equal(textarea.style.top, "40px");
  assert.equal(view.style.height, "20px");
  assert.equal(textarea.style.height, "20px");
});

test("anchor is preserved when the cursor moves during composition", () => {
  const { term, helper, view, textarea } = makeFakeTerm();
  fixImeCompositionOverflow(term as any);

  (helper as any).compositionstart();
  (helper as any).updateCompositionElements(false);

  // Simulate the cursor moving to another cell while the IME is still composing.
  term._core._bufferService.buffer.x = 9;
  term._core._bufferService.buffer.y = 4;
  (helper as any).updateCompositionElements(false);

  // The composition layer should stay at the original cell.
  assert.equal(view.style.left, "70px");
  assert.equal(textarea.style.left, "70px");
  assert.equal(view.style.top, "40px");
  assert.equal(textarea.style.top, "40px");
});

test("anchor is cleared after composition ends", () => {
  const { term, helper, view, textarea } = makeFakeTerm();
  fixImeCompositionOverflow(term as any);

  (helper as any).compositionstart();
  (helper as any).updateCompositionElements(false);
  assert.equal(view.style.left, "70px");
  assert.equal(view.style.top, "40px");

  (helper as any).compositionend();

  // After ending, xterm's own update should not be overwritten by the stale
  // anchor. Simulate xterm moving the overlay to the new cursor cell.
  term._core._bufferService.buffer.x = 9;
  term._core._bufferService.buffer.y = 4;
  const newLeft = `${term._core._bufferService.buffer.x * term._core._renderService.dimensions.css.cell.width}px`;
  const newTop = `${term._core._bufferService.buffer.y * term._core._renderService.dimensions.css.cell.height}px`;
  view.style.left = newLeft;
  view.style.top = newTop;
  textarea.style.left = newLeft;
  textarea.style.top = newTop;
  (helper as any).updateCompositionElements(false);
  assert.equal(view.style.left, newLeft);
  assert.equal(view.style.top, newTop);
  assert.equal(textarea.style.left, newLeft);
  assert.equal(textarea.style.top, newTop);
});
