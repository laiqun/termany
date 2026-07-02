import { WebSocketBackend } from "@termany/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { openExternal } from "../openExternal";

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

function apiUrl(): string {
  const configured = import.meta.env.VITE_API_URL || WS_URL || "http://localhost:5174";
  return configured.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/+$/, "");
}

export interface Session {
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  backend: WebSocketBackend;
  opened: boolean;
}

const sessions = new Map<string, Session>();
const pendingCwdFrom = new Map<string, string>();

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

  const backend = new WebSocketBackend(WS_URL, {
    session: id,
    cwdFrom: pendingCwdFrom.get(id),
  });
  pendingCwdFrom.delete(id);
  backend.onData((data) => {
    if (replaying) pendingOutput.push(data);
    else term.write(data);
  });
  backend.onExit(() => term.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n"));
  term.onData((data) => backend.write(data));

  // Select-to-copy: when the mouse is released over a non-empty selection, copy
  // it to the clipboard (iTerm/Terminal.app behaviour). The selection stays put.
  el.addEventListener("mouseup", () => {
    const sel = term.getSelection();
    if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
  });

  // Paste image blobs as local file paths, which keeps terminal input plain text
  // while still making screenshots available to CLI tools that accept images.
  el.addEventListener(
    "paste",
    (e) => {
      const images = pastedImages(e);
      if (!images.length) return;
      e.preventDefault();
      void (async () => {
        const settled = await Promise.allSettled(images.map(uploadClipboardImage));
        const paths = settled
          .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
          .map((result) => result.value);
        if (paths.length) backend.write(`${paths.join(" ")} `);
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
    s.opened = true;
  }
  fitSession(id);
  focusSession(id);
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
  sessions.get(id)?.term.focus();
}

/** Ask the server to start a not-yet-created session in another session's cwd. */
export function inheritSessionCwd(id: string, fromId: string) {
  if (!sessions.has(id)) pendingCwdFrom.set(id, fromId);
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
  // Drop its persisted restore data — a closed pane should not come back.
  fetch(`${apiUrl()}/api/forget`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  }).catch(() => {});
}
