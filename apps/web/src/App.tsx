import { useEffect, useState } from "react";
import { HTabBar } from "./components/HTabBar";
import { QuitConfirm } from "./components/QuitConfirm";
import { ResizeHandles } from "./components/ResizeHandles";
import { SearchPalette } from "./components/SearchPalette";
import { Settings, type SettingsSection } from "./components/Settings";
import { SideRail } from "./components/SideRail";
import { SplitView } from "./components/SplitView";
import { TreeSidebar } from "./components/TreeSidebar";
import { WindowControls } from "./components/WindowControls";
import { isTauri } from "./env";
import { ACTIONS, matchChord } from "./keybindings";
import { activeHtab, activeNode, useStore } from "./state/store";
import {
  adjustTerminalFontSize,
  clearSession,
  resetTerminalFontSize,
} from "./terminal/manager";
import { openLocalPathsInFocusedSession } from "./terminal/openLocalPath";
import { checkForUpdate } from "./updater";

export function App() {
  const htab = useStore(activeHtab);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const railCollapsed = useStore((s) => s.railCollapsed);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const settingsOpen = settingsSection !== null;

  // Settings and Search are full-panel overlays, so blanket-hiding every
  // native webview in the workspace while either is open is correct. The
  // SideRail agent-menu dropdown is small and floating, not full-panel — it
  // registers its own rect via nativeViewOcclusion instead, so it only
  // blanks the pane(s) it actually overlaps (see SideRail.tsx).
  useEffect(() => {
    const suppressed = settingsOpen || searchOpen;
    document.body.classList.toggle("native-webviews-suppressed", suppressed);
    window.dispatchEvent(
      new CustomEvent("termany:native-webviews-suppressed", { detail: suppressed }),
    );
    return () => {
      document.body.classList.remove("native-webviews-suppressed");
      window.dispatchEvent(
        new CustomEvent("termany:native-webviews-suppressed", { detail: false }),
      );
    };
  }, [settingsOpen, searchOpen]);

  // Global shortcuts. Each action's chord is user-customizable (Settings →
  // Keyboard, persisted to localStorage); the catalog and defaults live in
  // keybindings.ts. Here we just map every action id to what it does and fire
  // on the first chord that matches the live binding map.
  useEffect(() => {
    // Run an action by id against the current store snapshot.
    const handlers: Record<string, (s: ReturnType<typeof useStore.getState>) => void> = {
      newTab: (s) => s.addHTab(),
      closePane: (s) => s.closeFocusedPane(),
      splitRight: (s) => s.splitFocused("row"),
      splitDown: (s) => s.splitFocused("col"),
      toggleMaximize: (s) => {
        const h = activeHtab(s);
        if (h) s.toggleMaximize(h.focused);
      },
      zoomTerminalIn: (s) => {
        const h = activeHtab(s);
        if (h) adjustTerminalFontSize(h.focused, 1);
      },
      zoomTerminalOut: (s) => {
        const h = activeHtab(s);
        if (h) adjustTerminalFontSize(h.focused, -1);
      },
      resetTerminalZoom: (s) => {
        const h = activeHtab(s);
        if (h) resetTerminalFontSize(h.focused);
      },
      clearScreen: (s) => {
        const h = activeHtab(s);
        if (h) clearSession(h.focused);
      },
      nextTab: (s) => s.nextHTab(),
      prevTab: (s) => s.prevHTab(),
      nextPane: (s) => s.nextPane(),
      prevPane: (s) => s.prevPane(),
      newPage: (s) => s.addRootNode(),
      newChildPage: (s) => {
        const current = activeNode(s);
        if (current) s.addChildNode(current.id);
      },
      newWorkspace: (s) => s.addWorkspace(),
      previousTheme: (s) => s.prevTheme(),
      nextTheme: (s) => s.nextTheme(),
      toggleSidebar: (s) => s.toggleSidebar(),
      toggleRail: (s) => s.toggleRail(),
      openSettings: () => setSettingsSection("general"),
      search: () => setSearchOpen((o) => !o),
    };
    for (let i = 1; i <= 9; i++) {
      handlers[`switchTab${i}`] = (s) => {
        const node = activeNode(s);
        const htab = node?.htabs[i - 1];
        if (htab) s.setActiveHTab(htab.id);
      };
    }

    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      for (const action of ACTIONS) {
        const chord = s.keybindings[action.id] ?? action.default;
        if (matchChord(e, chord)) {
          e.preventDefault();
          handlers[action.id]?.(s);
          return;
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // Desktop: check for a new release once, shortly after startup (stays quiet —
  // just lights up the update badges; the install lives in Settings → About).
  useEffect(() => {
    if (!isTauri) return;
    const t = setTimeout(() => {
      checkForUpdate()
        .then((u) => u && useStore.getState().setUpdateVersion(u.version))
        .catch(() => {}); // offline / endpoint missing — try again next launch
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    const openPaths = (paths: unknown) => {
      if (cancelled || !Array.isArray(paths)) return;
      const localPaths = paths.filter((p): p is string => typeof p === "string");
      if (!localPaths.length) return;
      window.setTimeout(() => openLocalPathsInFocusedSession(localPaths), 100);
    };

    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string[]>("open-paths", (event) => {
        openPaths(event.payload);
      }))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else cleanup = unlisten;
      })
      .catch(() => {});

    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("frontend_ready_for_open_paths"))
      .then(openPaths)
      .catch(() => {});

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <div className={`app${isTauri ? " tauri" : ""}`}>
      {isTauri && <WindowControls />}
      {isTauri && <ResizeHandles />}
      {!collapsed && <TreeSidebar onOpenSettings={() => setSettingsSection("general")} />}
      <div className="main">
        <HTabBar />
        <div className="pane-area">
          <div className="pane-card">{htab && <SplitView key={htab.id} htab={htab} />}</div>
        </div>
      </div>
      {!railCollapsed && (
        <SideRail
          agentsOpen={agentsOpen}
          onAgentsOpenChange={setAgentsOpen}
          onOpenSettings={() => setSettingsSection("general")}
          onOpenAgentsSettings={() => setSettingsSection("agents")}
        />
      )}
      {settingsOpen && (
        <Settings
          initialSection={settingsSection ?? "appearance"}
          onClose={() => setSettingsSection(null)}
        />
      )}
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
      {isTauri && <QuitConfirm />}
    </div>
  );
}
