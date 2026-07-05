import { WebSocketBackend, type ITerminalBackend } from "@termany/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { apiUrl } from "../api";
import { DemoBackend, demoInteracted, isDemo } from "../demo";
import { ACTIONS, loadKeybindings, matchChord } from "../keybindings";
import { openExternal } from "../openExternal";
import { registerLocalPathLinks } from "./localLinks";

/**
 * The terminal session registry.
 *
 * Each pane maps to ONE Session that lives here, OUTSIDE React, so its shell and
 * scrollback survive being backgrounded (Wave / VS Code do the same).
 *
 * IMPORTANT: a Terminal must be `open()`ed into an element that is already in the
 * document — opening into a detached node leaves the renderer mis-initialised and
 * nothing paints but the cursor. So we create everything in getSession() but defer
 * open() to attachSession(), once the host is mounted.
 */

const WS_URL = import.meta.env.VITE_PTY_URL ?? "ws://localhost:5174";

export interface Session {
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  backend: ITerminalBackend;
  opened: boolean;
}

const sessions = new Map<string, Session>();
const pendingCwdFrom = new Map<string, string>();
const pendingCommands = new Map<string, string[]>();

/**
 * Lines of scrollback xterm keeps in memory per terminal. Sized to hold the
 * server's replayed history tail (SCROLL_CAP raw bytes ≈ a few thousand
 * visible lines) with room for the live session on top — going much higher
 * mostly burns webview memory on lines the history cap can't refill anyway.
 */
const SCROLLBACK_LINES = 5000;

/**
 * History tails from previous runs, keyed by session id, primed once at
 * startup (see scroll.ts). Each is replayed into its terminal the first time
 * that session is created, then dropped so a live session is never overwritten.
 */
const restoreSnapshots = new Map<string, string>();

/** Seed the saved histories before any session is attached (startup only). */
export function primeSnapshots(snapshots: Record<string, string>) {
  for (const [id, data] of Object.entries(snapshots)) {
    if (data) restoreSnapshots.set(id, data);
  }
}

/**
 * The visible screen of every session currently inside the ALTERNATE buffer
 * (fullscreen TUIs: claude, vim, htop…), as plain text — their raw output can't
 * be restored from history because leaving the alt screen discards it. `null`
 * for sessions on the primary screen (their history replay already covers
 * them), which tells the server to clear any stale capture. Sent at quit via
 * the scroll-flush beacon (see scroll.ts).
 */
export function finalScreens(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [id, s] of sessions) {
    if (!s.opened) continue;
    const buf = s.term.buffer.active;
    if (buf.type !== "alternate") {
      out[id] = null;
      continue;
    }
    const lines: string[] = [];
    for (let y = 0; y < s.term.rows; y++) {
      lines.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    out[id] = lines.join("\r\n");
  }
  return out;
}

/**
 * The terminal palette in effect. New sessions are created with it, and
 * applyTermTheme() retints every live session when the user switches themes.
 * Kept here (not in React) because the sessions it paints also live here.
 */
let currentTermTheme: ITheme = {
  background: "#0e1116",
  foreground: "#d7dce2",
  cursor: "#5ccfe6",
  selectionBackground: "#2a3441",
};

const IMAGE_MIMES = new Set(["image/gif", "image/jpeg", "image/png", "image/tiff", "image/webp"]);
const IMAGE_UTIS = new Map([
  ["public.jpeg", "image/jpeg"],
  ["public.jpg", "image/jpeg"],
  ["public.png", "image/png"],
  ["public.tiff", "image/tiff"],
  ["org.webmproject.webp", "image/webp"],
]);

function normalizeImageType(value: string): string {
  const type = value.toLowerCase();
  return IMAGE_UTIS.get(type) ?? type;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function readJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function uploadClipboardImage(file: File): Promise<string> {
  const type = normalizeImageType(file.type) || "image/png";
  const res = await fetch(`${apiUrl()}/api/paste-image?type=${encodeURIComponent(type)}`, {
    method: "POST",
    body: file,
  });
  let payload = await readJsonResponse(res);
  if (res.status === 404) {
    const fallback = await fetch(`${apiUrl()}/api/paste-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, data: arrayBufferToBase64(await file.arrayBuffer()) }),
    });
    payload = await readJsonResponse(fallback);
    if (!fallback.ok) throw new Error(payload.error ?? `upload failed (${fallback.status})`);
    return String(payload.path);
  }
  if (!res.ok) throw new Error(payload.error ?? `upload failed (${res.status})`);
  return String(payload.path);
}

function pastedImages(e: ClipboardEvent): File[] {
  const items = Array.from(e.clipboardData?.items ?? []);
  return items
    .filter((item) => IMAGE_MIMES.has(normalizeImageType(item.type)))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

/**
 * IME event tracing, enabled with `?imedebug` in the URL. Logs every
 * keyboard/composition/input event on xterm's hidden textarea plus what xterm
 * actually emits to the PTY, into an on-screen overlay + console. Kept as a
 * diagnostic — WebKit's IME event ordering has bitten us before (see
 * fixWebkitImeDirectInsert) and this pinpoints such bugs in one screenshot.
 */
const IME_DEBUG = new URLSearchParams(location.search).has("imedebug");
let imeLogEl: HTMLDivElement | null = null;
function imeLog(line: string) {
  if (!IME_DEBUG) return;
  if (!imeLogEl) {
    imeLogEl = document.createElement("div");
    imeLogEl.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:9999;max-width:60vw;max-height:45vh;" +
      "overflow:auto;background:rgba(0,0,0,.88);color:#9f9;font:11px/1.5 Menlo,monospace;" +
      "padding:8px 10px;border-radius:6px;pointer-events:none;white-space:pre-wrap;";
    document.body.appendChild(imeLogEl);
  }
  imeLogEl.textContent += line + "\n";
  imeLogEl.scrollTop = imeLogEl.scrollHeight;
  console.log("[ime]", line);
}

function traceImeEvents(term: Terminal) {
  if (!IME_DEBUG || !term.textarea) return;
  const ta = term.textarea;
  const fmt = (v: unknown) => JSON.stringify(v ?? null);
  for (const type of ["keydown", "keypress", "keyup"]) {
    ta.addEventListener(
      type,
      (e) => {
        const k = e as KeyboardEvent;
        imeLog(
          `${type} key=${fmt(k.key)} code=${k.code} keyCode=${k.keyCode} ` +
            `composing=${k.isComposing} ta=${fmt(ta.value)}`
        );
      },
      true
    );
  }
  for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
    ta.addEventListener(
      type,
      (e) => imeLog(`${type} data=${fmt((e as CompositionEvent).data)} ta=${fmt(ta.value)}`),
      true
    );
  }
  for (const type of ["beforeinput", "input"]) {
    ta.addEventListener(
      type,
      (e) => {
        const i = e as InputEvent;
        imeLog(
          `${type} inputType=${i.inputType} data=${fmt(i.data)} ` +
            `composing=${i.isComposing} ta=${fmt(ta.value)}`
        );
      },
      true
    );
  }
  ta.addEventListener("focus", () => imeLog("focus"), true);
  ta.addEventListener("blur", () => imeLog("blur"), true);
}

/** Switch the terminal palette: future sessions + all currently open ones. */
export function applyTermTheme(theme: ITheme) {
  currentTermTheme = theme;
  for (const s of sessions.values()) s.term.options.theme = theme;
}

function getSession(id: string): Session {
  const existing = sessions.get(id);
  if (existing) return existing;

  const el = document.createElement("div");
  el.className = "term-host";

  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize: 13,
    scrollback: SCROLLBACK_LINES,
    cursorBlink: true,
    allowProposedApi: true,
    theme: currentTermTheme,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);

  // xterm swallows every keydown it decides to handle (preventDefault +
  // stopPropagation) before it can bubble up to App.tsx's window-level
  // shortcut listener — so with a terminal focused (the common case, since
  // typing IS the terminal), app shortcuts like ⌘W silently did nothing.
  // Step aside for any key that matches a live user shortcut binding so it
  // reaches the app instead of being typed into the shell.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const keybindings = loadKeybindings();
    for (const action of ACTIONS) {
      if (matchChord(event, keybindings[action.id] ?? action.default)) return false;
    }
    return true;
  });

  // Replay the previous run's output tail (server-captured, sanitized) ABOVE
  // the fresh shell, so a reopened pane shows where it left off. The raw replay
  // can leave the emulator in a mode the dead shell set (alt screen, mouse
  // reporting, scroll margins, hidden cursor, line-drawing charset…), so
  // neutralise all of that before drawing the divider. Two hard-won subtleties:
  //  - `?1049l` is sent ONLY if the replay actually ended inside the alternate
  //    screen: on the normal screen it performs a cursor RESTORE to a stale
  //    saved position, teleporting the cursor up into the restored content —
  //    which the new shell's erase-below then wipes out.
  //  - The reset runs in write-callbacks (async), so the new shell's first
  //    output is held in `pendingOutput` until the divider is down; otherwise
  //    it could interleave into the middle of the reset sequence.
  const pendingOutput: string[] = [];
  let replaying = false;
  const snapshot = restoreSnapshots.get(id);
  if (snapshot) {
    restoreSnapshots.delete(id);
    replaying = true;
    term.write(snapshot, () => {
      const finishReset = () => {
        const row = term.buffer.active.cursorY + 1; // where the replay ended
        term.write(
          "\x1b[r\x1b[?1000;1002;1003;1006l\x1b[?1004l\x1b[?2004l\x1b[?6l\x1b[?7h" +
            "\x1b[?25h\x1b(B\x0f\x1b[0m" +
            `\x1b[${row};1H\x1b7` + // re-park at the content end; overwrite stale saved-cursor
            "\r\n", // no divider — history flows straight into the new shell
          () => {
            replaying = false;
            for (const d of pendingOutput.splice(0)) term.write(d);
          }
        );
      };
      if (term.buffer.active.type === "alternate") term.write("\x1b[?1049l", finishReset);
      else finishReset();
    });
  }

  // Make URLs in terminal output clickable — open in the system browser on
  // desktop, a new tab on web. (xterm only underlines/links on hover by default
  // once this addon is loaded.)
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      void openExternal(uri);
    })
  );
  // Local file paths (including relative ones like `src/foo.ts`) are verified
  // and resolved by the server against this shell's live cwd. If the server
  // can't answer (demo mode, old server), fall back to trusting absolute
  // paths unverified so links don't disappear entirely.
  registerLocalPathLinks(term, async (paths) => {
    const fallback = () => paths.map((p) => (/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(p) ? p : null));
    if (isDemo) return fallback();
    try {
      const res = await fetch(`${apiUrl()}/api/resolve-paths`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: id, paths }),
      });
      if (!res.ok) return fallback();
      const payload = await readJsonResponse(res);
      return Array.isArray(payload.resolved) ? payload.resolved : fallback();
    } catch {
      return fallback();
    }
  });

  const backend: ITerminalBackend = isDemo
    ? new DemoBackend(id)
    : new WebSocketBackend(WS_URL, {
        session: id,
        cwdFrom: pendingCwdFrom.get(id),
      });
  pendingCwdFrom.delete(id);
  backend.onData((data) => {
    if (replaying) {
      pendingOutput.push(data);
      return;
    }
    // xterm only auto-follows the bottom when a LINE FEED grows the buffer.
    // TUIs that redraw in place (cursor up + rewrite, no new lines — codex,
    // claude, most Ink-based UIs) don't trigger that, so once the viewport
    // has drifted even ONE line off the bottom (trackpad momentum still
    // ticking after the user's last deliberate scroll, a resize) their
    // updates render below the fold until the user scrolls back or presses a
    // key (xterm snaps to bottom on input, which is why typing "fixes" it).
    // Restore the follow behavior for this case too. A small slack — rather
    // than requiring EXACT bottom — is what makes this actually catch the
    // momentum-drift case; a real deliberate scroll-up (reading scrollback)
    // moves far more than this and correctly falls outside it, so it's left
    // alone instead of being yanked back down.
    const NEAR_BOTTOM_SLACK_LINES = 3;
    const buf = term.buffer.active;
    const nearBottom = buf.baseY - buf.viewportY <= NEAR_BOTTOM_SLACK_LINES;
    term.write(data, () => {
      if (nearBottom) term.scrollToBottom();
    });
  });
  backend.onExit((reason) => {
    const message = reason ? `[session ended: ${reason}]` : "[session ended]";
    term.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
  });
  term.onData((data) => {
    if (IME_DEBUG) imeLog(`→PTY ${JSON.stringify(data)}`);
    backend.write(data);
  });

  // Select-to-copy: when the mouse is released over a non-empty selection, copy
  // it to the clipboard (iTerm/Terminal.app behaviour). The selection stays put.
  el.addEventListener("mouseup", () => {
    const sel = term.getSelection();
    if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
  });

  // Paste image blobs as local file paths, which keeps terminal input plain text
  // while still making screenshots available to CLI tools that accept images.
  // Duplicate-fire guard: swallow a second image paste while one is still
  // uploading or within a short cooldown — key auto-repeat on a held ⌘V (and
  // any double-dispatched event) otherwise inserts the same screenshot twice.
  let imagePasteBusyUntil = 0;
  el.addEventListener(
    "paste",
    (e) => {
      if (isDemo) return; // no upload endpoint — let text paste through, drop images
      const images = pastedImages(e);
      if (!images.length) return;
      e.preventDefault();
      // Also stop xterm's own paste handler (it ignores defaultPrevented and
      // pastes any text/plain flavor riding along with the image — e.g. the
      // source file path when copying from WeChat/Preview/browsers — which
      // otherwise lands in the prompt as a SECOND image reference).
      e.stopPropagation();
      if (Date.now() < imagePasteBusyUntil) return;
      imagePasteBusyUntil = Date.now() + 1000;
      void (async () => {
        const settled = await Promise.allSettled(images.map(uploadClipboardImage));
        const paths = settled
          .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
          .map((result) => result.value);
        // Deliver through xterm's paste pipeline, NOT as raw keystrokes: apps
        // with bracketed paste on (claude, vim, modern shells) then receive ONE
        // paste event — Claude Code recognizes a pasted image path and shows
        // just its [Image #N] chip instead of echoing the path as typed text.
        if (paths.length) term.paste(`${paths.join(" ")} `);
        if (!paths.length) {
          const reason = settled.find(
            (result): result is PromiseRejectedResult => result.status === "rejected"
          )?.reason;
          const msg = reason instanceof Error ? reason.message : String(reason ?? "unknown error");
          term.write(`\r\n\x1b[31m[termany] failed to paste image: ${msg}\x1b[0m\r\n`);
        }
      })();
    },
    true
  );

  const session: Session = { el, term, fit, backend, opened: false };
  sessions.set(id, session);
  return session;
}

/**
 * WKWebView/Safari IME fix: SHIFTED full-width punctuation from a CJK IME
 * (？ ： etc.) arrives as keydown keyCode 229 + an `insertText` input event,
 * with NO composition events. xterm's 229 fallback snapshots the textarea on
 * keydown and diffs it a tick later — on WebKit that diff runs one keystroke
 * LATE, so each press shows the PREVIOUS character ("press twice to type").
 * Catch exactly that shape ourselves: forward the inserted text and clear the
 * textarea so xterm's late diff finds nothing to (re)send. Unshifted marks
 * (，。) use real keycodes and normal pinyin uses composition events — both
 * are skipped here and keep working through xterm's own paths.
 */
function fixWebkitImeDirectInsert(term: Terminal) {
  const ua = navigator.userAgent;
  const isPureWebKit = ua.includes("AppleWebKit") && !/Chrome|Chromium|Edg\//.test(ua);
  if (!isPureWebKit || !term.textarea) return;
  const ta = term.textarea;
  const MODIFIERS = new Set([16, 17, 18, 91, 93]); // shift ctrl alt meta(L/R)
  let composing = false;
  let compositionEndedAt = 0;
  let lastRealKeydownAt = 0; // any non-modifier, non-229 keydown

  ta.addEventListener(
    "keydown",
    (e) => {
      if (e.keyCode !== 229 && !MODIFIERS.has(e.keyCode)) lastRealKeydownAt = performance.now();
    },
    true
  );
  ta.addEventListener("compositionstart", () => (composing = true), true);
  ta.addEventListener(
    "compositionend",
    () => {
      composing = false;
      compositionEndedAt = performance.now();
    },
    true
  );
  // Intercept at BEFOREINPUT — it precedes xterm's own `input` listener, so
  // cancelling here means the character never reaches the textarea and xterm
  // never sees an input event: exactly one copy goes to the PTY, ours.
  ta.addEventListener(
    "beforeinput",
    (e) => {
      const ev = e as InputEvent;
      if (ev.inputType !== "insertText" || !ev.data) return; // compositions, paste, deletes…
      if (composing || ev.isComposing || performance.now() - compositionEndedAt < 150) {
        imeLog("fix:skip composition window");
        return;
      }
      // A normal keystroke's keydown → beforeinput chain is sub-millisecond.
      // An IME direct insert has NO real keydown before it (WebKit delivers
      // its keyCode-229 keydown AFTER the input events), so any gap means IME.
      if (performance.now() - lastRealKeydownAt < 30) {
        imeLog(`fix:skip normal-typing ${JSON.stringify(ev.data)}`);
        return;
      }
      ev.preventDefault();
      imeLog(`fix:SEND ${JSON.stringify(ev.data)}`);
      term.input(ev.data, true);
    },
    true
  );
}

/** Attach the session's element into `host` and open the terminal (once). */
export function attachSession(id: string, host: HTMLElement) {
  const s = getSession(id);
  host.appendChild(s.el);
  if (!s.opened) {
    s.term.open(s.el); // el is now in the document — renderer initialises correctly
    // GPU renderer: the default DOM renderer repaints character-by-character and
    // makes echo feel laggy. WebGL must be loaded AFTER open(). If the GPU context
    // is lost (driver reset / tab backgrounded), dispose so xterm falls back to DOM.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      s.term.loadAddon(webgl);
    } catch {
      /* no WebGL available — DOM renderer still works */
    }
    fixWebkitImeDirectInsert(s.term);
    traceImeEvents(s.term);
    s.opened = true;
  }
  fitSession(id);
  focusSession(id);
  const queued = pendingCommands.get(id);
  if (queued?.length) {
    pendingCommands.delete(id);
    window.setTimeout(() => {
      for (const command of queued) sendCommand(id, command);
    }, 50);
  }
}

/** Detach from the DOM but keep the session (and its shell) alive. */
export function detachSession(id: string, host: HTMLElement) {
  const s = sessions.get(id);
  if (s && s.el.parentNode === host) host.removeChild(s.el);
}

/** Refit to the current container size and tell the PTY the new dimensions. */
export function fitSession(id: string) {
  const s = sessions.get(id);
  if (!s || !s.opened) return;
  try {
    s.fit.fit();
    s.backend.resize(s.term.cols, s.term.rows);
  } catch {
    /* container not laid out yet */
  }
}

export function focusSession(id: string) {
  // In the landing-page demo iframe, programmatic focus on load would steal
  // the visitor's keyboard/scroll — hold off until they click into the demo.
  if (isDemo && !demoInteracted()) return;
  sessions.get(id)?.term.focus();
}

/**
 * Clear the screen (⌘K) by sending Ctrl+L (0x0c) to the PTY, the same as a
 * real terminal — NOT `term.clear()`. That call unilaterally keeps only the
 * cursor's current row and discards the rest of xterm's buffer, which desyncs
 * any program that tracks its own layout for relative-cursor redraws (shells'
 * multi-line prompts, and especially full-screen-ish TUIs like claude/codex
 * that repaint via "move cursor up N, erase, redraw" — see incident where
 * this broke mid-conversation rendering). Ctrl+L instead asks whatever's
 * actually running to redraw itself, so it can never get out of sync with
 * what's really on screen: readline's clear-screen for a plain shell, or the
 * TUI's own repaint if one is in front.
 */
export function clearSession(id: string) {
  sessions.get(id)?.backend.write("\x0c");
}

/** Ask the server to start a not-yet-created session in another session's cwd. */
export function inheritSessionCwd(id: string, fromId: string) {
  if (!sessions.has(id)) pendingCwdFrom.set(id, fromId);
}

/**
 * Type a command into the session's shell and press Enter, as if the user
 * had. Used to `cd` an existing terminal to wherever the file tree navigated
 * to when switching back from it — a no-op (and safe) if `id` has no live
 * session yet, same as clearSession above.
 */
export function sendCommand(id: string, command: string) {
  sessions.get(id)?.backend.write(`${command}\r`);
}

export function queueCommand(id: string, command: string) {
  if (sessions.has(id)) {
    sendCommand(id, command);
    return;
  }
  pendingCommands.set(id, [...(pendingCommands.get(id) ?? []), command]);
}

/** Insert text at the cursor via xterm's paste pipeline — same path clipboard
 *  image paste uses (see the `paste` listener above), so apps with bracketed
 *  paste on (vim, claude, modern shells) see it as one paste, not typed
 *  keystrokes. Used for dropping a file/folder from Finder onto the pane. */
export function pasteIntoSession(id: string, text: string) {
  sessions.get(id)?.term.paste(text);
}

export function sessionUsesAlternateBuffer(id: string): boolean {
  return sessions.get(id)?.term.buffer.active.type === "alternate";
}

export function sessionLooksLikeAgentInput(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.term.buffer.active.type === "alternate") return true;

  const buf = session.term.buffer.active;
  const start = Math.max(0, buf.viewportY);
  const end = Math.min(buf.length, start + session.term.rows);
  const lines: string[] = [];
  for (let y = start; y < end; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  return /\b(OpenAI Codex|Claude Code)\b|Use \/skills|\/model to change|bypass permissions/i.test(lines.join("\n"));
}

/** Permanently destroy a session — only when the user closes the pane/tab. */
export function disposeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  s.backend.dispose();
  s.term.dispose();
  s.el.remove();
  sessions.delete(id);
  restoreSnapshots.delete(id);
  if (isDemo) return;
  // Drop its persisted restore data — a closed pane should not come back.
  fetch(`${apiUrl()}/api/forget`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  }).catch(() => {});
}
