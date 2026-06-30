import { useEffect, useState } from "react";
import {
  ACTIONS,
  type ActionGroup,
  chordFromEvent,
  chordsEqual,
  DEFAULT_KEYBINDINGS,
  formatChord,
} from "../keybindings";
import { useStore } from "../state/store";

const GROUPS: ActionGroup[] = ["Tabs & panes", "Navigation", "Appearance", "General"];

/**
 * Keyboard-shortcut customization. Click a binding to capture the next chord;
 * Esc cancels. Bindings are stored per-action in the global store (persisted to
 * localStorage). Two actions sharing a chord are flagged — the earlier one in
 * the catalog wins at dispatch time (see App.tsx).
 */
export function KeyboardSettings() {
  const keybindings = useStore((s) => s.keybindings);
  const setKeybinding = useStore((s) => s.setKeybinding);
  const resetKeybindings = useStore((s) => s.resetKeybindings);
  const [capturing, setCapturing] = useState<string | null>(null);

  // While capturing, swallow the next chord (capture phase, so it beats both the
  // app's global shortcuts and the Settings Esc-to-close handler).
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setCapturing(null);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // modifier-only — keep waiting
      setKeybinding(capturing, chord);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, setKeybinding]);

  // chord string → action ids, to flag duplicates.
  const byChord = new Map<string, string[]>();
  for (const a of ACTIONS) {
    const key = formatChord(keybindings[a.id] ?? a.default);
    byChord.set(key, [...(byChord.get(key) ?? []), a.id]);
  }

  return (
    <>
      <div className="ms-head">
        <div className="settings-section-title" style={{ marginBottom: 0 }}>
          KEYBOARD SHORTCUTS
        </div>
        <button className="ms-btn" onClick={resetKeybindings}>
          Reset all
        </button>
      </div>

      {GROUPS.map((group) => (
        <div key={group} className="kb-group">
          <div className="kb-group-title">{group}</div>
          {ACTIONS.filter((a) => a.group === group).map((a) => {
            const chord = keybindings[a.id] ?? a.default;
            const label = formatChord(chord);
            const conflict = (byChord.get(label)?.length ?? 0) > 1;
            const isCustom = !chordsEqual(chord, DEFAULT_KEYBINDINGS[a.id]);
            return (
              <div key={a.id} className="kb-row">
                <span className="kb-label">{a.label}</span>
                <div className="kb-controls">
                  {isCustom && capturing !== a.id && (
                    <button
                      className="kb-reset"
                      title="Reset to default"
                      onClick={() => setKeybinding(a.id, null)}
                    >
                      Reset
                    </button>
                  )}
                  <button
                    className={`kb-chord${capturing === a.id ? " capturing" : ""}${
                      conflict ? " conflict" : ""
                    }`}
                    title={conflict ? "Conflicts with another shortcut" : "Click to rebind"}
                    onClick={() => setCapturing(capturing === a.id ? null : a.id)}
                  >
                    {capturing === a.id ? "Press keys…" : label}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
