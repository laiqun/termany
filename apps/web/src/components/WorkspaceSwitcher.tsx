import { useState } from "react";
import { useStore } from "../state/store";
import { EmojiPicker } from "./EmojiPicker";
import { ChevronIcon, PlusIcon } from "./icons";

const initial = (t: string) => t.trim().charAt(0).toUpperCase() || "?";

/**
 * Notion-style workspace header at the top of the sidebar: [icon] [name ▾].
 * - icon → emoji picker (defaults to the title's first letter)
 * - name → dropdown to switch / create; double-click to rename inline
 *
 * The collapse + prev/next controls live in the tab strip (HTabBar), Notion-style.
 */
export function WorkspaceSwitcher() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const setWorkspaceIcon = useStore((s) => s.setWorkspaceIcon);

  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];

  const avatar = (w: { icon?: string; title: string }, sm = false) =>
    w.icon ? (
      <span className={`ws-avatar emoji${sm ? " sm" : ""}`}>{w.icon}</span>
    ) : (
      <span className={`ws-avatar${sm ? " sm" : ""}`}>{initial(w.title)}</span>
    );

  return (
    <div className="ws-switcher">
      <div className="ws-head">
        <button className="ws-icon-btn" title="Change icon" onClick={() => setEmojiOpen((o) => !o)}>
          {avatar(active)}
        </button>

        {editing ? (
          <input
            className="ws-rename"
            autoFocus
            defaultValue={active.title}
            onBlur={(e) => {
              renameWorkspace(active.id, e.target.value.trim() || active.title);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <button
            className="ws-name-btn"
            onClick={() => setMenuOpen((o) => !o)}
            onDoubleClick={() => {
              setMenuOpen(false);
              setEditing(true);
            }}
          >
            <span className="ws-name">{active.title}</span>
            <span className="ws-chevron">
              <ChevronIcon dir="down" />
            </span>
          </button>
        )}
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
              <button
                key={w.id}
                className="ws-menu-item"
                onClick={() => {
                  setActiveWorkspace(w.id);
                  setMenuOpen(false);
                }}
              >
                {avatar(w, true)}
                <span className="ws-menu-name">{w.title}</span>
                {w.id === activeId && <span className="ws-check">✓</span>}
              </button>
            ))}
            <div className="ws-menu-sep" />
            <button
              className="ws-menu-item new"
              onClick={() => {
                addWorkspace();
                setMenuOpen(false);
              }}
            >
              <span className="ws-plus"><PlusIcon /></span>
              <span className="ws-menu-name">New workspace</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
