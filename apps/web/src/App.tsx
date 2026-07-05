import { useEffect, useState } from "react";
import { HTabBar } from "./components/HTabBar";
import { ResizeHandles } from "./components/ResizeHandles";
import { SearchPalette } from "./components/SearchPalette";
import { Settings } from "./components/Settings";
import { SideRail } from "./components/SideRail";
import { SplitView } from "./components/SplitView";
import { TreeSidebar } from "./components/TreeSidebar";
import { WindowControls } from "./components/WindowControls";
import { isTauri } from "./env";
import { ACTIONS, matchChord } from "./keybindings";
import { activeHtab, activeNode, useStore } from "./state/store";
import { clearSession } from "./terminal/manager";
import { checkForUpdate } from "./updater";

export function App() {
  const htab = useStore(activeHtab);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const railCollapsed = useStore((s) => s.railCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

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
      clearScreen: (s) => {
        const h = activeHtab(s);
        if (h) clearSession(h.focused);
      },
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
      openSettings: () => setSettingsOpen(true),
      search: () => setSearchOpen((o) => !o),
    };

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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  return (
    <div className={`app${isTauri ? " tauri" : ""}`}>
      {isTauri && <WindowControls />}
      {isTauri && <ResizeHandles />}
      {!collapsed && <TreeSidebar onOpenSettings={() => setSettingsOpen(true)} />}
      <div className="main">
        <HTabBar />
        <div className="pane-area">
          <div className="pane-card">{htab && <SplitView key={htab.id} htab={htab} />}</div>
        </div>
      </div>
      {!railCollapsed && <SideRail />}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
