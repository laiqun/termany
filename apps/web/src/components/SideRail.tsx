import { useStore } from "../state/store";
import { FilesIcon, TerminalIcon } from "./icons";

/** One entry per pane kind this rail can quick-create. Add web/sysinfo/process
 *  here later — each just needs an icon and a `view` the store understands. */
const RAIL_ITEMS: Array<{ view: "terminal" | "files"; label: string; icon: () => JSX.Element }> = [
  { view: "terminal", label: "terminal", icon: TerminalIcon },
  { view: "files", label: "files", icon: FilesIcon },
];

/**
 * Workspace-level quick-action rail, sitting beside the pane card (like the
 * left sidebar's page tree, but for panes). Not tied to any one pane — each
 * button splits the currently focused pane and opens a fresh one directly in
 * that view, instead of switching an existing pane's view in place (that's
 * still the per-pane header button, toggled via togglePaneView).
 */
export function SideRail() {
  const addPane = useStore((s) => s.addPane);

  return (
    <div className="side-rail">
      {RAIL_ITEMS.map(({ view, label, icon: Icon }) => (
        <button key={view} className="side-rail-btn" title={`New ${label} pane`} onClick={() => addPane(view)}>
          <Icon />
        </button>
      ))}
    </div>
  );
}
