import { apiPath } from "../api";
import { demoState, isDemo } from "../demo";
import { useStore } from "./store";

/**
 * True once the server has answered a state load. Saves are gated on this:
 * if we never managed to load, persisting would OVERWRITE the user's real
 * layout in SQLite with this webview's in-memory defaults.
 */
let hydrated = false;

/**
 * Wait for the local server to answer. The bundled server boots in parallel
 * with the webview and usually loses that race by a few hundred ms — without
 * this, startup hydrates from a dead socket and renders the default layout.
 */
export async function waitForServer(timeoutMs = 12_000): Promise<boolean> {
  if (isDemo) return true; // no server to wait for
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(apiPath("/api/state"), { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * The webview is a reflection of server state now (SQLite), not the source of
 * truth. Hydrate the store from the server on startup; fall back to a one-time
 * import of the old localStorage blob so existing layouts aren't lost.
 */
export async function loadState(): Promise<void> {
  if (isDemo) {
    // Curated layout; `hydrated` stays false so nothing is ever persisted.
    useStore.setState({ ...demoState(), sidebarCollapsed: false });
    return;
  }
  try {
    const res = await fetch(apiPath("/api/state"));
    if (res.ok) {
      hydrated = true; // an empty-but-ok answer is a genuine fresh install
      const s = await res.json();
      if (Array.isArray(s.workspaces) && s.workspaces.length) {
        useStore.setState({
          workspaces: s.workspaces,
          activeWorkspace: s.activeWorkspace || s.workspaces[0].id,
          sidebarCollapsed: !!s.sidebarCollapsed,
        });
        return;
      }
    }
  } catch {
    /* server unreachable — keep the in-memory defaults */
  }

  // Migrate a previous localStorage layout (old zustand-persist blob) if any.
  try {
    const ls = localStorage.getItem("termany.workspaces");
    if (ls) {
      const parsed = JSON.parse(ls);
      const st = parsed?.state ?? parsed;
      if (Array.isArray(st?.workspaces) && st.workspaces.length) {
        useStore.setState({
          workspaces: st.workspaces,
          activeWorkspace: st.activeWorkspace || st.workspaces[0].id,
          sidebarCollapsed: !!st.sidebarCollapsed,
        });
      }
      localStorage.removeItem("termany.workspaces");
    }
  } catch {
    /* ignore a malformed legacy blob */
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Debounced save of the layout slice to the server on every store change. */
export function startStateSync(): void {
  if (isDemo) return;
  useStore.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Never persist a layout we never loaded — see `hydrated`.
      if (!hydrated) return;
      const { workspaces, activeWorkspace, sidebarCollapsed } = useStore.getState();
      fetch(apiPath("/api/state"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaces, activeWorkspace, sidebarCollapsed }),
      }).catch(() => {});
    }, 400);
  });
}
