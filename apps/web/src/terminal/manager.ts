import { WebSocketBackend } from "@termany/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

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

async function uploadClipboardImage(file: File): Promise<string> {
  const type = normalizeImageType(file.type) || "image/png";
  const res = await fetch(`${apiUrl()}/api/paste-image?type=${encodeURIComponent(type)}`, {
    method: "POST",
    body: file,
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
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
    cursorBlink: true,
    allowProposedApi: true,
    theme: currentTermTheme,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);

  const backend = new WebSocketBackend(WS_URL, {
    session: id,
    cwdFrom: pendingCwdFrom.get(id),
  });
  pendingCwdFrom.delete(id);
  backend.onData((data) => term.write(data));
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
}
