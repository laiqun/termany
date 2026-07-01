import { liveSessionIds, primeSnapshots, snapshotSession } from "./manager";

const WS_URL = import.meta.env.VITE_PTY_URL ?? "ws://localhost:5174";

function apiUrl(): string {
  const configured = import.meta.env.VITE_API_URL || WS_URL || "http://localhost:5174";
  return configured.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/+$/, "");
}

/**
 * Terminal scrollback restore: each open terminal's screen + scrollback is
 * serialized and persisted server-side (SQLite), then replayed as a static
 * snapshot above the fresh shell when the app reopens. Pairs with the server's
 * cwd restore so a reopened pane shows its last output AND lands in its old dir.
 */

/** Fetch the saved snapshots and prime the manager BEFORE the first attach. */
export async function loadSnapshots(): Promise<void> {
  try {
    const res = await fetch(`${apiUrl()}/api/scroll`);
    if (res.ok) primeSnapshots(await res.json());
  } catch {
    /* server unreachable — start with no restored scrollback */
  }
}

/** Serialize every live terminal into an `{ id: data }` map. */
function collect(): Record<string, string> {
  const snapshots: Record<string, string> = {};
  for (const id of liveSessionIds()) {
    const data = snapshotSession(id);
    if (data) snapshots[id] = data;
  }
  return snapshots;
}

/**
 * Persist snapshots on an interval (the backbone) plus a reliable flush when the
 * window goes away. `fetch` from an unload handler is dropped by the browser, so
 * the final flush uses `sendBeacon`, which the server accepts as a POST.
 */
export function startScrollSync(): void {
  const save = () => {
    const snapshots = collect();
    if (!Object.keys(snapshots).length) return;
    fetch(`${apiUrl()}/api/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshots }),
    }).catch(() => {});
  };

  const flush = () => {
    const snapshots = collect();
    if (!Object.keys(snapshots).length) return;
    const blob = new Blob([JSON.stringify({ snapshots })], { type: "application/json" });
    navigator.sendBeacon?.(`${apiUrl()}/api/scroll`, blob);
  };

  setInterval(save, 10_000);
  // pagehide fires on app/tab close (incl. the Tauri webview); visibilitychange
  // covers backgrounding, where the app may be killed without a further event.
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
