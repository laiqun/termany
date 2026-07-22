import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  ACTIONS,
  type ActionGroup,
  type Chord,
  chordFromEvent,
  chordsEqual,
  DEFAULT_KEYBINDINGS,
  formatChord,
} from "../keybindings";
import { useI18n } from "../i18n";
import { useStore } from "../state/store";
import { isTauri } from "../env";
import {
  getWindowToggleShortcut,
  globalShortcutWarning,
  setWindowToggleShortcut,
  SUGGESTED_TOGGLE_CHORD,
} from "../windowToggle";

/**
 * One shortcut line, shared by every row on this page: the label, an optional
 * row-specific control, and — always last, so the chords line up in a column —
 * the chord button, which doubles as the recorder.
 *
 * `idle` dims the chord to mean "picked, but not in effect"; `conflict` marks
 * it red. `note` is at most one line of explanation below the row, for the
 * cases where a chord needs one.
 */
function ShortcutRow({
  label,
  chord,
  capturing,
  onToggleCapture,
  title,
  conflict,
  idle,
  control,
  note,
}: {
  label: string;
  chord: Chord;
  capturing: boolean;
  onToggleCapture: () => void;
  title?: string;
  conflict?: boolean;
  idle?: boolean;
  control?: ReactNode;
  note?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="kb-row">
        <span className="kb-label">{label}</span>
        <div className="kb-controls">
          {control}
          <button
            className={`kb-chord${capturing ? " capturing" : ""}${conflict ? " conflict" : ""}${
              idle && !capturing ? " idle" : ""
            }`}
            title={title}
            onClick={onToggleCapture}
          >
            {capturing ? t("kb.capturing") : formatChord(chord)}
          </button>
        </div>
      </div>
      {note}
    </>
  );
}

/** Display order for the sections, paired with their i18n key. */
const GROUPS: { group: ActionGroup; key: string }[] = [
  { group: "Tabs & panes", key: "kb.group.tabs" },
  { group: "Navigation", key: "kb.group.navigation" },
  { group: "Appearance", key: "kb.group.appearance" },
  { group: "General", key: "kb.group.general" },
];

/**
 * Keyboard-shortcut customization. Click a binding to capture the next chord;
 * Esc cancels. Bindings are stored per-action in the global store (persisted to
 * localStorage). Two actions sharing a chord are flagged — the earlier one in
 * the catalog wins at dispatch time (see App.tsx).
 */
export function KeyboardSettings() {
  const { t } = useI18n();
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
          {t("kb.title")}
        </div>
        <button className="ms-btn" onClick={resetKeybindings}>
          {t("kb.resetAll")}
        </button>
      </div>

      {isTauri && <GlobalToggleRow />}

      {GROUPS.map(({ group, key }) => (
        <div key={group} className="kb-group">
          <div className="kb-group-title">{t(key)}</div>
          {ACTIONS.filter((a) => a.group === group).map((a) => {
            const chord = keybindings[a.id] ?? a.default;
            const conflict = (byChord.get(formatChord(chord))?.length ?? 0) > 1;
            const isCustom = !chordsEqual(chord, DEFAULT_KEYBINDINGS[a.id]);
            return (
              <ShortcutRow
                key={a.id}
                label={t(`kb.action.${a.id}`)}
                chord={chord}
                capturing={capturing === a.id}
                onToggleCapture={() => setCapturing(capturing === a.id ? null : a.id)}
                title={conflict ? t("kb.conflict") : t("kb.rebind")}
                conflict={conflict}
                control={
                  isCustom &&
                  capturing !== a.id && (
                    <button
                      className="kb-reset"
                      title={t("kb.resetTitle")}
                      onClick={() => setKeybinding(a.id, null)}
                    >
                      {t("kb.reset")}
                    </button>
                  )
                }
              />
            );
          })}
        </div>
      ))}
    </>
  );
}

/**
 * The OS-wide show/hide shortcut (see windowToggle.ts). Off until switched
 * on, but the chord field is never blank — it starts on a suggestion, shown
 * dimmed while inactive, so picking one (the genuinely hard part of this
 * feature) is a decision the user can accept rather than invent. At most one
 * note appears below the row: a registration error, or a warning for a known
 * silent conflict (IMEs, launchers, Termany's own bindings).
 */
function GlobalToggleRow() {
  const { t } = useI18n();
  const keybindings = useStore((s) => s.keybindings);
  // The chord shown in the field. Editable while off, when it is only a
  // pending choice that no one has registered yet.
  const [chord, setChord] = useState(SUGGESTED_TOGGLE_CHORD);
  // undefined = still loading the registered shortcut from the Rust side.
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState(false);
  const restoreRef = useRef<Chord | null>(null);

  useEffect(() => {
    void getWindowToggleShortcut()
      .then((registered) => {
        if (registered) setChord(registered);
        setEnabled(!!registered);
      })
      .catch(() => setEnabled(false));
  }, []);

  /** Register `next` (or unregister with null); reports failure to the row. */
  const apply = useCallback(async (next: Chord | null): Promise<boolean> => {
    try {
      await setWindowToggleShortcut(next);
      setEnabled(!!next);
      setError(false);
      return true;
    } catch {
      setError(true);
      return false;
    }
  }, []);

  const startCapture = () => {
    // Free the keys while recording, or pressing the active chord is consumed
    // OS-side (it just hides the window) instead of being captured.
    restoreRef.current = enabled ? chord : null;
    if (enabled) void setWindowToggleShortcut(null).catch(() => {});
    setError(false);
    setCapturing(true);
  };

  const stopCapture = useCallback(() => {
    setCapturing(false);
    if (restoreRef.current) void setWindowToggleShortcut(restoreRef.current).catch(() => {});
    restoreRef.current = null;
  }, []);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        stopCapture();
        return;
      }
      const next = chordFromEvent(e);
      if (!next) return; // modifier-only — keep waiting
      setCapturing(false);
      const previous = restoreRef.current;
      restoreRef.current = null;
      setChord(next);
      // While off, the new chord is just a pending choice — nothing to
      // register until the switch is flipped.
      if (!previous) return;
      void (async () => {
        // Keep the working shortcut if the new one can't be registered.
        if (!(await apply(next))) {
          setChord(previous);
          await setWindowToggleShortcut(previous).catch(() => {});
        }
      })();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, apply, stopCapture]);

  // Settings closed mid-recording: put the previous binding back.
  useEffect(
    () => () => {
      if (restoreRef.current) void setWindowToggleShortcut(restoreRef.current).catch(() => {});
    },
    []
  );

  if (enabled === undefined) return null;
  // A global hotkey fires even while Termany is focused, so a chord that is
  // also an in-app binding silently overrides that action.
  const inAppClash = enabled
    ? ACTIONS.find((a) => chordsEqual(keybindings[a.id] ?? a.default, chord))
    : undefined;
  const warning = enabled && !capturing ? globalShortcutWarning(chord) : null;
  return (
    <div className="kb-group">
      <div className="kb-group-title">{t("kb.group.global")}</div>
      <ShortcutRow
        label={t("kb.global.toggleWindow")}
        chord={chord}
        capturing={capturing}
        onToggleCapture={() => (capturing ? stopCapture() : startCapture())}
        title={t("kb.rebind")}
        conflict={error}
        idle={!enabled}
        control={
          <div className="agent-enable-toggle">
            <button className={enabled ? "active" : ""} onClick={() => void apply(chord)}>
              {t("kb.global.on")}
            </button>
            <button className={enabled ? "" : "active"} onClick={() => void apply(null)}>
              {t("kb.global.off")}
            </button>
          </div>
        }
        note={
          error ? (
            <div className="kb-note kb-note-error">{t("kb.global.error")}</div>
          ) : inAppClash ? (
            <div className="kb-note kb-note-warn">
              {t("kb.global.warn.inApp", { name: t(`kb.action.${inAppClash.id}`) })}
            </div>
          ) : warning ? (
            <div className="kb-note kb-note-warn">{t(warning.key, warning.params)}</div>
          ) : null
        }
      />
    </div>
  );
}
