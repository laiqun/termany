import { useEffect, useRef, useState } from "react";
import { attachSession, detachSession, fitSession, focusSession, pasteIntoSession } from "../terminal/manager";

function fileUrlToPath(url: string): string | null {
  if (!url.startsWith("file://")) return null;
  try {
    let p = decodeURIComponent(new URL(url).pathname);
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // file:///C:/... on Windows
    return p;
  } catch {
    return null;
  }
}

/**
 * Extract absolute local paths from a native OS file drop (Finder → this
 * pane). What's actually available depends on the webview: `text/uri-list`
 * `file://` entries (some WebKit versions populate this for local-file
 * drags) or a `File.path` (an Electron-only extension a Tauri build may or
 * may not shim) — neither is guaranteed with this app's `dragDropEnabled:
 * false` (see pasteIntoSession's doc comment in manager.ts for why that's
 * set). If nothing yields a real path, returns empty so the caller no-ops
 * instead of pasting garbage.
 */
function extractDroppedPaths(dt: DataTransfer): string[] {
  const uriList = dt.getData("text/uri-list");
  if (uriList) {
    const paths = uriList
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map(fileUrlToPath)
      .filter((p): p is string => !!p);
    if (paths.length) return paths;
  }
  return Array.from(dt.files)
    .map((f) => (f as File & { path?: string }).path)
    .filter((p): p is string => !!p);
}

/** Escape a path for insertion, UNQUOTED, into a shell command line — the
 *  same convention Terminal.app/iTerm2 use when you drag a file in: backslash
 *  each character the shell would otherwise treat specially, rather than
 *  wrapping the whole thing in quotes, so several dropped files land as
 *  separate ready-to-use arguments. */
function escapeForShell(path: string): string {
  return path.replace(/([ \\'"()[\]{}$&;|<>*?!`#~])/g, "\\$1");
}

/**
 * Mounts the persistent session DOM node for `id` into this slot. On unmount we
 * only DETACH the node — the session keeps living in the registry so its shell
 * and scrollback survive being backgrounded.
 */
export function TerminalPane({ id }: { id: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    attachSession(id, host);

    // Coalesce resize bursts (window/split-drag fires RO every frame) to ONE fit
    // per animation frame — fit.fit() measures + reflows the grid and sends a PTY
    // resize, so running it per RO callback floods the socket while dragging.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        fitSession(id);
      });
    });
    ro.observe(host);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      detachSession(id, host);
    };
  }, [id]);

  return (
    <div
      className={`term-pane ${dragOver ? "drag-over" : ""}`}
      ref={hostRef}
      onMouseDown={() => focusSession(id)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const paths = extractDroppedPaths(e.dataTransfer);
        if (paths.length) pasteIntoSession(id, `${paths.map(escapeForShell).join(" ")} `);
      }}
    />
  );
}
