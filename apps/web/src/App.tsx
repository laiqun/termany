import { useEffect, useState } from "react";
import { HTabBar } from "./components/HTabBar";
import { ResizeHandles } from "./components/ResizeHandles";
import { Settings } from "./components/Settings";
import { SplitView } from "./components/SplitView";
import { TreeSidebar } from "./components/TreeSidebar";
import { WindowControls } from "./components/WindowControls";
import { isTauri } from "./env";
import { ACTIONS, matchChord } from "./keybindings";
import { activeHtab, activeNode, useStore } from "./state/store";

export function App() {
  const htab = useStore(activeHtab);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
      newPage: (s) => s.addRootNode(),
      newChildPage: (s) => {
        const current = activeNode(s);
        if (current) s.addChildNode(current.id);
      },
      newWorkspace: (s) => s.addWorkspace(),
      previousTheme: (s) => s.prevTheme(),
      nextTheme: (s) => s.nextTheme(),
      toggleSidebar: (s) => s.toggleSidebar(),
      openSettings: () => setSettingsOpen(true),
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
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
