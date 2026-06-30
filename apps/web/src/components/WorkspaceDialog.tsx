import { useState } from "react";
import { EmojiPicker } from "./EmojiPicker";

const initial = (t: string) => t.trim().charAt(0).toUpperCase() || "?";

/**
 * Create / edit a workspace: pick an emoji icon and type a name. Used both for
 * "New workspace" (empty initial) and editing an existing one.
 */
export function WorkspaceDialog({
  title: initTitle = "",
  icon: initIcon,
  confirmLabel = "Done",
  onConfirm,
  onClose,
}: {
  title?: string;
  icon?: string;
  confirmLabel?: string;
  onConfirm: (v: { title: string; icon?: string }) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initTitle);
  const [icon, setIcon] = useState<string | undefined>(initIcon);
  const [pickerOpen, setPickerOpen] = useState(false);

  const submit = () => {
    if (title.trim()) onConfirm({ title: title.trim(), icon });
  };

  return (
    <div className="ws-dialog-backdrop" onClick={onClose}>
      <div className="ws-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ws-dialog-row">
          <button className="ws-dialog-icon" title="Choose icon" onClick={() => setPickerOpen((o) => !o)}>
            {icon ? (
              <span className="ws-avatar emoji">{icon}</span>
            ) : (
              <span className="ws-avatar">{initial(title)}</span>
            )}
          </button>
          <input
            className="ws-dialog-input"
            autoFocus
            value={title}
            placeholder="Workspace name"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return; // let the IME handle Enter/Esc
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") onClose();
            }}
          />
        </div>

        {pickerOpen && (
          <EmojiPicker
            onPick={(e) => {
              setIcon(e ?? undefined);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}

        <div className="ws-dialog-actions">
          <button className="ws-dialog-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="ws-dialog-btn primary" onClick={submit} disabled={!title.trim()}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
