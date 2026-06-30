import { useStore } from "./store";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:5174";

/**
 * The webview is a reflection of server state now (SQLite), not the source of
 * truth. Hydrate the store from the server on startup; fall back to a one-time
 * import of the old localStorage blob so existing layouts aren't lost.
 */
export async function loadState(): Promise<void> {
  try {
    const res = await fetch(`${API}/api/state`);
    if (res.ok) {
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
  useStore.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const { workspaces, activeWorkspace, sidebarCollapsed } = useStore.getState();
      fetch(`${API}/api/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaces, activeWorkspace, sidebarCollapsed }),
      }).catch(() => {});
    }, 400);
  });
}
