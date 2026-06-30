import { useState } from "react";
import { useStore } from "../state/store";
import { EmojiPicker } from "./EmojiPicker";
import { ChevronIcon, EditIcon, GearIcon, PlusIcon } from "./icons";
import { WorkspaceDialog } from "./WorkspaceDialog";

const initial = (t: string) => t.trim().charAt(0).toUpperCase() || "?";

type DialogState = { mode: "new" } | { mode: "edit"; id: string; title: string; icon?: string };

/**
 * Notion-style workspace header at the top of the sidebar: [icon] [name ▾].
 * The dropdown switches workspaces, edits them (hover → pencil), creates new
 * ones (via a name/icon dialog), and opens Settings.
 */
export function WorkspaceSwitcher({ onOpenSettings }: { onOpenSettings: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const setWorkspaceIcon = useStore((s) => s.setWorkspaceIcon);

  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];

  const avatar = (w: { icon?: string; title: string }, sm = false) =>
    w.icon ? (
      <span className={`ws-avatar emoji${sm ? " sm" : ""}`}>{w.icon}</span>
    ) : (
      <span className={`ws-avatar${sm ? " sm" : ""}`}>{initial(w.title)}</span>
    );

  return (
    <div className="ws-switcher">
      <div className="ws-head" data-tauri-drag-region>
        <button className="ws-icon-btn" title="Change icon" onClick={() => setEmojiOpen((o) => !o)}>
          {avatar(active)}
        </button>
        <button className="ws-name-btn" onClick={() => setMenuOpen((o) => !o)}>
          <span className="ws-name">{active.title}</span>
          <span className="ws-chevron">
            <ChevronIcon dir="down" />
          </span>
        </button>
      </div>

      {emojiOpen && (
        <EmojiPicker
          onPick={(emoji) => {
            setWorkspaceIcon(active.id, emoji);
            setEmojiOpen(false);
          }}
          onClose={() => setEmojiOpen(false)}
        />
      )}

      {menuOpen && (
        <>
          <div className="ws-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="ws-menu">
            {workspaces.map((w) => (
              <div className="ws-menu-item" key={w.id}>
                <button
                  className="ws-menu-pick"
                  onClick={() => {
                    setActiveWorkspace(w.id);
                    setMenuOpen(false);
                  }}
                >
                  {avatar(w, true)}
                  <span className="ws-menu-name">{w.title}</span>
                </button>
                <button
                  className="ws-menu-edit"
                  title="Edit workspace"
                  onClick={() => {
                    setMenuOpen(false);
                    setDialog({ mode: "edit", id: w.id, title: w.title, icon: w.icon });
                  }}
                >
                  <EditIcon />
                </button>
                {w.id === activeId && <span className="ws-check">✓</span>}
              </div>
            ))}

            <div className="ws-menu-sep" />
            <button
              className="ws-menu-row new"
              onClick={() => {
                setMenuOpen(false);
                setDialog({ mode: "new" });
              }}
            >
              <span className="ws-menu-ico">
                <PlusIcon />
              </span>
              <span className="ws-menu-name">New workspace</span>
            </button>
            <button
              className="ws-menu-row"
              onClick={() => {
                setMenuOpen(false);
                onOpenSettings();
              }}
            >
              <span className="ws-menu-ico">
                <GearIcon />
              </span>
              <span className="ws-menu-name">Settings</span>
            </button>
          </div>
        </>
      )}

      {dialog?.mode === "new" && (
        <WorkspaceDialog
          confirmLabel="Create"
          onConfirm={({ title, icon }) => {
            addWorkspace({ title, icon });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.mode === "edit" && (
        <WorkspaceDialog
          title={dialog.title}
          icon={dialog.icon}
          onConfirm={({ title, icon }) => {
            renameWorkspace(dialog.id, title);
            setWorkspaceIcon(dialog.id, icon ?? null);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
