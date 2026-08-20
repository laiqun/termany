// Copied from https://github.com/msdshsk/xterm-ime-anchor (MIT license).
// Vendored because the package is not published to npm and its repo `dist/`
// is not included in the git-install tarball.
//
// IME anchor heuristic for xterm.js.
//
// Problem: Ink-based TUIs (Claude Code, inkchat, …) don't cursor-park at the
// input field after rendering, so the terminal's hardware cursor — and
// therefore xterm.js's IME anchor — ends up at the wrong place.
//
// Observation: every Ink <TextInput> we've looked at draws its caret
// indicator as a single inverse-video space (SGR 7 + ' ' + SGR 27) on the
// input row.  Regardless of where the hardware cursor is, that inverse cell
// reliably marks the visual input position.
//
// xterm.js's CompositionHelper owns TWO DOM elements that both need to be at
// "where the user expects IME to appear":
//   1. `.xterm-helper-textarea` — the hidden input that receives IME events.
//      The browser anchors the IME candidate panel to this element.
//   2. `.composition-view` — a visible <div> that xterm.js renders the
//      preedit (未確定文字列 — the underlined in-progress text) INTO,
//      positioned absolutely inside `.xterm-helpers`.
//
// xterm's internal `updateCompositionElements()` writes `style.left/top` on
// both elements every ~0 ms via setTimeout recursion while composing, always
// based on `buffer.x/y` (the hardware cursor).  We therefore:
//   a) compute the anchor on compositionstart,
//   b) pin both elements' left/top to that anchor with !important, and
//   c) observe the style attribute of each and re-pin when xterm overwrites.
//
// Fall-through: if no inverse cell is in the visible viewport, we do nothing
// and let xterm.js keep its default hardware-cursor anchor (correct for
// normal shells, because shells naturally cursor-park after their prompt).

import type { Terminal } from "@xterm/xterm";

export type ImeAnchor = {
  source: "heuristic" | "hardware";
  col: number;
  row: number;
};

export type AttachOptions = {
  /** Fired after every anchor computation (successful or fall-through). */
  onAnchor?: (a: ImeAnchor) => void;
  /**
   * If the inverse-cell we're about to anchor on has BOTH neighbours also
   * inverse, we've likely latched onto a selected-menu-row rather than an Ink
   * caret (caret = one lone inverse cell).  Default: true.
   */
  requireIsolatedCell?: boolean;
};

type Detached = { detach(): void };

export function attachImeHeuristic(
  terminal: Terminal,
  options: AttachOptions = {}
): Detached {
  const { onAnchor, requireIsolatedCell = true } = options;

  const root = terminal.element;
  if (!root) return { detach() {} };

  // xterm.js stable DOM structure (since 4.x):
  //   .xterm
  //     .xterm-screen
  //       .xterm-helpers
  //         .xterm-helper-textarea   (hidden input for IME capture)
  //         .composition-view        (visible div for preedit text)
  const textarea = root.querySelector(
    ".xterm-helper-textarea"
  ) as HTMLTextAreaElement | null;
  const screen = root.querySelector(".xterm-screen") as HTMLElement | null;
  const compositionView = root.querySelector(
    ".composition-view"
  ) as HTMLElement | null;

  if (!textarea || !screen || !compositionView) {
    return { detach() {} };
  }

  let composing = false;
  let pinned: { left: string; top: string } | null = null;
  let renderDisposable: { dispose(): void } | null = null;

  // A single MutationObserver routed at both elements — we re-apply whenever
  // xterm's recursive setTimeout writes the hardware-cursor coordinates back.
  const reapply = (el: HTMLElement) => {
    if (!composing || !pinned) return;
    if (el.style.left !== pinned.left || el.style.top !== pinned.top) {
      el.style.setProperty("left", pinned.left, "important");
      el.style.setProperty("top", pinned.top, "important");
    }
  };
  const moTa = new MutationObserver(() => reapply(textarea));
  const moCv = new MutationObserver(() => reapply(compositionView));

  function computeCellSize(): { w: number; h: number } {
    const rect = screen!.getBoundingClientRect();
    return {
      w: rect.width / Math.max(terminal.cols, 1),
      h: rect.height / Math.max(terminal.rows, 1),
    };
  }

  function findInverseCell(): { col: number; row: number } | null {
    const buf = terminal.buffer.active;
    const rows = terminal.rows;
    const startY = buf.viewportY;

    // Right-to-left, bottom-up: trailing caret indicators win over
    // earlier decorative inverse runs.
    for (let y = startY + rows - 1; y >= startY; y--) {
      const line = buf.getLine(y);
      if (!line) continue;
      for (let x = line.length - 1; x >= 0; x--) {
        const cell = line.getCell(x);
        if (!cell) continue;
        if (!cell.isInverse()) continue;

        if (requireIsolatedCell) {
          const left = x > 0 ? line.getCell(x - 1) : null;
          const right = x + 1 < line.length ? line.getCell(x + 1) : null;
          const leftInv = !!left && !!left.isInverse();
          const rightInv = !!right && !!right.isInverse();
          // Neighbours-both-inverse → selection bar / highlight row. Skip.
          if (leftInv && rightInv) continue;
        }

        return { col: x, row: y - startY };
      }
    }
    return null;
  }

  /**
   * Re-scan the buffer and update the pin.  Called on compositionstart AND
   * on every render while composing.  The latter is required for IME partial
   * commit: when the user keeps typing mid-conversion, the browser emits a
   * compositionend+compositionstart pair; Ink hasn't redrawn yet at that
   * instant (the just-committed text is still in flight to the PTY), so the
   * caret's inverse cell is at the OLD position.  A couple of render ticks
   * later Ink redraws with the new caret — this handler follows it.
   */
  function recomputeAndPin() {
    if (!composing) return;

    const hit = findInverseCell();
    if (!hit) {
      // Don't reset `pinned` here: the buffer state between partial-commit
      // render cycles can transiently lose the inverse cell (Ink sometimes
      // clears-then-redraws).  Keep the last known anchor until composition
      // ends or a new inverse cell is found.
      return;
    }

    const { w, h } = computeCellSize();
    const left = `${Math.round(hit.col * w)}px`;
    const top = `${Math.round(hit.row * h)}px`;

    if (pinned && pinned.left === left && pinned.top === top) return;

    pinned = { left, top };
    textarea!.style.setProperty("left", left, "important");
    textarea!.style.setProperty("top", top, "important");
    compositionView!.style.setProperty("left", left, "important");
    compositionView!.style.setProperty("top", top, "important");

    onAnchor?.({ source: "heuristic", col: hit.col, row: hit.row });
  }

  function onCompositionStart() {
    composing = true;

    // Initial scan.  If no inverse cell is present right now, fall through
    // to xterm's hardware-cursor anchor (correct for normal shells).
    const hit = findInverseCell();
    if (!hit) {
      pinned = null;
      onAnchor?.({
        source: "hardware",
        col: terminal.buffer.active.cursorX,
        row: terminal.buffer.active.cursorY,
      });
    } else {
      const { w, h } = computeCellSize();
      const left = `${Math.round(hit.col * w)}px`;
      const top = `${Math.round(hit.row * h)}px`;
      pinned = { left, top };
      textarea!.style.setProperty("left", left, "important");
      textarea!.style.setProperty("top", top, "important");
      compositionView!.style.setProperty("left", left, "important");
      compositionView!.style.setProperty("top", top, "important");
      onAnchor?.({ source: "heuristic", col: hit.col, row: hit.row });
    }

    // Follow subsequent renders — this is what catches the partial-commit
    // case where Ink redraws its caret mid-composition.
    renderDisposable = terminal.onRender(() => recomputeAndPin());
  }

  function onCompositionEnd() {
    composing = false;
    pinned = null;
    renderDisposable?.dispose();
    renderDisposable = null;
    // Let xterm.js take its natural position back on the next cursor tick.
  }

  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);
  moTa.observe(textarea, { attributes: true, attributeFilter: ["style"] });
  moCv.observe(compositionView, {
    attributes: true,
    attributeFilter: ["style"],
  });

  return {
    detach() {
      composing = false;
      pinned = null;
      renderDisposable?.dispose();
      renderDisposable = null;
      textarea.removeEventListener("compositionstart", onCompositionStart);
      textarea.removeEventListener("compositionend", onCompositionEnd);
      moTa.disconnect();
      moCv.disconnect();
    },
  };
}
