import type { Terminal } from "@xterm/xterm";

/**
 * Back-port of xterm.js's IME composition overflow fix (upstream #5747).
 *
 * Problem: while a Chinese IME is composing, xterm renders the pre-edit string
 * in an absolutely positioned `.composition-view` overlay with no width limit.
 * When the cursor is near the right edge, the overlay grows past the terminal
 * boundary, stretching the pane horizontally and making the whole split layout
 * jump left/right as the pre-edit string changes length.
 *
 * This monkey-patches the internal `CompositionHelper` to:
 *  - cap the composition view's width to the space between the cursor and the
 *    terminal's right edge;
 *  - clip overflow so the view can never widen the terminal;
 *  - anchor the visible end of the pre-edit at the cursor using `direction: rtl`
 *    while wrapping the text in LTR marks so characters stay in logical order.
 *
 * It also adds a render-time fallback so the clipping is re-applied even if
 * xterm's internal `updateCompositionElements` runs outside of our wrapper.
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

  function remainingWidth(): number {
    const hostWidth = host.clientWidth;
    const viewLeft = parseFloat(compositionView.style.left || "0");
    return Math.max(0, hostWidth - viewLeft);
  }

  function clampCompositionView(): void {
    if (!helper?.isComposing) return;
    const maxWidth = remainingWidth();

    compositionView.style.maxWidth = `${maxWidth}px`;
    compositionView.style.overflow = "hidden";
    compositionView.style.direction = "rtl";

    // The hidden textarea's caret position determines where the OS IME
    // candidate window appears. Keep its width clipped too so the caret never
    // drifts past the terminal's right edge.
    const taWidth = parseFloat(textarea.style.width || "0");
    if (taWidth > maxWidth) {
      textarea.style.width = `${maxWidth}px`;
    }
    textarea.style.maxWidth = `${maxWidth}px`;
    textarea.style.overflow = "hidden";

    // Ensure the text itself is wrapped in LTR marks so `direction: rtl`
    // aligns the string's end to the cursor without reversing the characters.
    const text = compositionView.textContent ?? "";
    if (text && !/^\u200E.*\u200E$/.test(text)) {
      compositionView.textContent = `\u200E${text}\u200E`;
    }
  }

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
      const cellWidth = renderService.dimensions.css.cell.width;
      const cursorLeft = cursorX * cellWidth;
      const maxWidth = Math.max(0, buf.cols * cellWidth - cursorLeft);

      compositionView.style.maxWidth = `${maxWidth}px`;
      compositionView.style.overflow = "hidden";
      compositionView.style.direction = "rtl";
    }
    originalUpdate(dontRecurse);
  };

  // Fallback: re-apply clipping after every render in case xterm bypasses our
  // wrapper (e.g. via its internal `onRender` hook).
  term.onRender(() => clampCompositionView());
}
