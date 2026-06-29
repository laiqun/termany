import { useEffect, useState } from "react";
import { HTabBar } from "./components/HTabBar";
import { Settings } from "./components/Settings";
import { SplitView } from "./components/SplitView";
import { TreeSidebar } from "./components/TreeSidebar";
import { isTauri } from "./env";
import { activeHtab, activeNode, useStore } from "./state/store";

export function App() {
  const htab = useStore(activeHtab);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Global shortcuts. Require ⌘ (never Ctrl — Ctrl+D/W/C are real shell keys).
  //
  // Matched on e.code (physical key) so the optional ⌥ works too: the browser
  // reserves ⌘T/⌘W/⌘⇧N for itself, so in a browser tab use ⌘⌥T / ⌘⌥W / ⌘⌥⇧N.
  // In the desktop app there's no browser chrome, so plain ⌘T etc. just work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey) return;
      const s = useStore.getState();

      switch (e.code) {
        case "KeyT":
          e.preventDefault();
          s.addHTab();
          break;
        case "KeyD":
          e.preventDefault();
          s.splitFocused(e.shiftKey ? "col" : "row"); // ⌘D side-by-side, ⌘⇧D stacked
          break;
        case "KeyW":
          e.preventDefault();
          s.closeFocusedPane();
          break;
        case "Enter":
        case "NumpadEnter": {
          e.preventDefault();
          const current = activeNode(s);
          if (current) s.addChildNode(current.id);
          break;
        }
        case "KeyN":
          e.preventDefault();
          if (e.shiftKey) s.addWorkspace();
          else s.addRootNode();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`app${isTauri ? " tauri" : ""}`}>
      {!collapsed && <TreeSidebar onOpenSettings={() => setSettingsOpen(true)} />}
      <div className="main">
        <HTabBar />
        <div className="pane-area">
          {htab && <SplitView key={htab.id} htab={htab} />}
        </div>
      </div>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
