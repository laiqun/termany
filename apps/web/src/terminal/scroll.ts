import { apiPath } from "../api";
import { isDemo } from "../demo";
import { finalScreens, primeSnapshots } from "./manager";

/**
 * Terminal history restore: the SERVER tails every session's raw PTY output
 * into a capped ring (SQLite-backed) as it happens — the frontend never
 * serializes screens. On reopen the saved tail is replayed into the fresh
 * terminal's scrollback. Pairs with the server's cwd restore so a reopened
 * pane shows its last output AND lands in its old directory.
 */

/** Fetch the saved histories and prime the manager BEFORE the first attach. */
export async function loadSnapshots(): Promise<void> {
  if (isDemo) return; // nothing persisted, nothing to restore
  try {
    const res = await fetch(apiPath("/api/scroll"));
    if (res.ok) primeSnapshots(await res.json());
  } catch {
    /* server unreachable — start with no restored scrollback */
  }
}

/**
 * Ask the server to persist its in-memory history rings when the window goes
 * away — on quit the app may SIGKILL the server before its next timed flush.
 * The beacon body carries final-screen captures for sessions inside a TUI's
 * alternate screen (which raw history replay cannot restore). `sendBeacon` is
 * used because plain fetch is dropped from unload handlers; the blob is
 * text/plain so the cross-origin beacon needs no CORS preflight.
 */
export function startScrollSync(): void {
  if (isDemo) return;
  const flush = () => {
    const blob = new Blob([JSON.stringify({ screens: finalScreens() })], { type: "text/plain" });
    navigator.sendBeacon?.(apiPath("/api/scroll/flush"), blob);
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  // The quit beacon races the app killing the server, so also sync on an
  // interval — a lost race then costs at most the last few seconds of a TUI's
  // screen. Tiny payload (nulls unless a session is inside a fullscreen app).
  setInterval(() => {
    fetch(apiPath("/api/scroll/flush"), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ screens: finalScreens() }),
    }).catch(() => {});
  }, 15_000);
}
