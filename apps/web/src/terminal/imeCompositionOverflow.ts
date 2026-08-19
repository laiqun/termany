import type { Terminal } from "@xterm/xterm";

/**
 * Back-port of xterm.js's IME composition overflow fix (upstream #5747) plus a
 * position anchor patch.
 *
 * Problem: while a Chinese IME is composing, xterm renders the pre-edit string
 * in an absolutely positioned `.composition-view` overlay with no width limit.
 * When the cursor is near the right edge, the overlay grows past the terminal
 * boundary, stretching the pane horizontally and making the whole split layout
 * jump left/right as the pre-edit string changes length.
 *
 * A second symptom with some IMEs (e.g. WeChat IME on the web) is that xterm
 * repositions both the overlay and the hidden helper textarea on every
 * composition update. Because the OS IME re-reads the textarea anchor
 * mid-composition, any cursor movement — left/right or up/down — makes the IME
 * caret / pre-edit popup follow it and the pane appears to shake.
 *
 * We freeze the overlay and the hidden textarea at the cursor position that
 * existed when composition started. Width is still clipped to the terminal
 * right edge and the text is still rendered right-to-left so it grows toward
 * the left, but the anchor point itself does not move until composition ends.
 *
 * This monkey-patches the internal `CompositionHelper` to:
 *  - cap the composition view's width to the space between the anchor and the
 *    terminal's right edge;
 *  - clip overflow so the view can never widen the terminal;
 *  - anchor the visible end of the pre-edit at the cursor using `direction: rtl`
 *    while wrapping the text in LTR marks so characters stay in logical order;
 *  - pin the composition view and textarea position to the cursor cell where
 *    composition started, preventing X/Y jumps while the IME is open.
 *
 * It also adds a render-time fallback so the clipping is re-applied even if
 * xterm's internal `onRender` hook runs outside of our wrapper.
 *
 * The patch is safe to apply unconditionally: it only touches the composition
 * view, which is only visible during an active IME composition.
 */
export function fixImeCompositionOverflow(term: Terminal): void {
  const core = (term as any)._core;
  const helper = core?._compositionHelper;
  const renderService = core?._renderService;
  const bufferService = core?._bufferService;
  const compositionView = helper?._compositionView as HTMLElement | undefined;
  const textarea = term.textarea;
  const host = term.element;

  if (!compositionView || !textarea || !host) return;

  // eslint-disable-next-line no-console
  console.log("[ime] composition overflow fix attached");

  const view = compositionView;
  const ta = textarea;
  const hostEl = host;

  let anchorLeft: number | null = null;
  let anchorTop: number | null = null;

  function cellWidth(): number {
    return renderService?.dimensions?.css?.cell?.width ?? 0;
  }

  function cellHeight(): number {
    return renderService?.dimensions?.css?.cell?.height ?? 0;
  }

  function remainingWidth(): number {
    const hostWidth = hostEl.clientWidth;
    const viewLeft = anchorLeft ?? parseFloat(view.style.left || "0");
    return Math.max(0, hostWidth - viewLeft);
  }

  function applyAnchor(): void {
    if (anchorLeft !== null) {
      view.style.left = `${anchorLeft}px`;
      ta.style.left = `${anchorLeft}px`;
    }
    if (anchorTop !== null) {
      view.style.top = `${anchorTop}px`;
      ta.style.top = `${anchorTop}px`;
    }
  }

  function clampCompositionView(): void {
    if (!helper?.isComposing) return;
    const maxWidth = remainingWidth();
    const height = cellHeight();

    view.style.maxWidth = `${maxWidth}px`;
    view.style.overflow = "hidden";
    view.style.direction = "rtl";

    // The hidden textarea's caret position determines where the OS IME
    // candidate window appears. Keep its width clipped too so the caret never
    // drifts past the terminal's right edge.
    const taWidth = parseFloat(ta.style.width || "0");
    if (taWidth > maxWidth) {
      ta.style.width = `${maxWidth}px`;
    }
    ta.style.maxWidth = `${maxWidth}px`;
    ta.style.overflow = "hidden";

    // Keep the composition layer exactly one cell tall. Some browsers expand
    // the overlay when `direction: rtl` is combined with long text, which can
    // push the hidden textarea and the IME caret down.
    if (height > 0) {
      view.style.height = `${height}px`;
      view.style.maxHeight = `${height}px`;
      view.style.lineHeight = `${height}px`;
      ta.style.height = `${height}px`;
      ta.style.maxHeight = `${height}px`;
      ta.style.lineHeight = `${height}px`;
    }

    // Pin the overlay and textarea to the starting cursor cell so they do not
    // ride the cursor left/right/up/down while the IME is open.
    applyAnchor();

    // Ensure the text itself is wrapped in LTR marks so `direction: rtl`
    // aligns the string's end to the cursor without reversing the characters.
    const text = view.textContent ?? "";
    if (text && !/^\u200E.*\u200E$/.test(text)) {
      view.textContent = `\u200E${text}\u200E`;
    }
  }

  function computeAnchor(): { left: number; top: number } | null {
    const buf = bufferService?.buffer;
    const rows = bufferService?.rows;
    const cols = bufferService?.cols ?? buf?.cols;
    const width = cellWidth();
    const height = cellHeight();
    if (!buf || width <= 0 || height <= 0 || cols == null) return null;
    const x = Math.max(0, Math.min(buf.x, cols - 1));
    const y = Math.max(0, Math.min(buf.y, rows - 1));
    return { left: x * width, top: y * height };
  }

  const originalCompositionStart = helper.compositionstart?.bind(helper);
  helper.compositionstart = () => {
    const anchor = computeAnchor();
    if (anchor) {
      anchorLeft = anchor.left;
      anchorTop = anchor.top;
    }
    originalCompositionStart?.();
  };

  const originalCompositionEnd = helper.compositionend?.bind(helper);
  helper.compositionend = () => {
    anchorLeft = null;
    anchorTop = null;
    originalCompositionEnd?.();
  };

  const originalCompositionUpdate = helper.compositionupdate.bind(helper);
  helper.compositionupdate = (ev: Pick<CompositionEvent, "data">) => {
    // `direction: rtl` on the composition view would visually reverse the
    // pre-edit string. Wrapping it in LTR marks keeps the character order
    // correct while still letting `direction: rtl` align the string's end to
    // the cursor side, so overflow is clipped from the far side, not the side
    // the user is reading.
    const wrapped = ev.data ? `\u200E${ev.data}\u200E` : ev.data;
    originalCompositionUpdate({ data: wrapped } as Pick<CompositionEvent, "data">);
  };

  const originalUpdate = helper.updateCompositionElements.bind(helper);
  helper.updateCompositionElements = (dontRecurse?: boolean) => {
    if (helper.isComposing) {
      const buf = bufferService.buffer;
      const cursorX = Math.min(buf.x, buf.cols - 1);
      const left = anchorLeft ?? cursorX * cellWidth();
      const maxWidth = Math.max(0, hostEl.clientWidth - left);
      const height = cellHeight();

      compositionView.style.maxWidth = `${maxWidth}px`;
      compositionView.style.overflow = "hidden";
      compositionView.style.direction = "rtl";

      if (height > 0) {
        compositionView.style.height = `${height}px`;
        compositionView.style.maxHeight = `${height}px`;
        compositionView.style.lineHeight = `${height}px`;
        ta.style.height = `${height}px`;
        ta.style.maxHeight = `${height}px`;
        ta.style.lineHeight = `${height}px`;
      }
    }
    originalUpdate(dontRecurse);
    // Re-apply the anchor after xterm positions the elements, because xterm
    // derives `left`/`top` from the current cursor cell on every call.
    applyAnchor();
  };

  // Fallback: re-apply clipping after every render in case xterm bypasses our
  // wrapper (e.g. via its internal `onRender` hook).
  term.onRender(() => clampCompositionView());
}
