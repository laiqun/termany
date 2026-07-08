/**
 * Customizable keyboard shortcuts.
 *
 * Every global shortcut is an "action" with a default chord. The user can
 * rebind any action from Settings → Keyboard; overrides are persisted to
 * localStorage and merged over the defaults on load (so new actions shipped in
 * a later build still show up with their default binding).
 *
 * Chords match on `KeyboardEvent.code` (the physical key, layout-independent)
 * plus an EXACT set of modifiers — unlike a fuzzy match, ⌘T and ⌘⌥T are
 * distinct, which is what makes rebinding predictable.
 */

/** A single key combination. `code` is a KeyboardEvent.code (e.g. "KeyT"). */
export interface Chord {
  code: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Logical groups, used to section the Settings list. */
export type ActionGroup = "Tabs & panes" | "Navigation" | "Appearance" | "General";

export interface ActionDef {
  id: string;
  label: string;
  group: ActionGroup;
  default: Chord;
}

/**
 * The catalog of bindable actions. The dispatch behaviour for each id lives in
 * App.tsx (keeps this module free of any store/UI coupling). To add a shortcut:
 * append an entry here and a matching case in App.tsx's handler map.
 */
export const ACTIONS: ActionDef[] = [
  { id: "newTab", label: "New terminal tab", group: "Tabs & panes", default: { code: "KeyT", meta: true } },
  { id: "closePane", label: "Close pane / tab", group: "Tabs & panes", default: { code: "KeyW", meta: true } },
  { id: "splitRight", label: "Split right", group: "Tabs & panes", default: { code: "KeyD", meta: true } },
  { id: "splitDown", label: "Split down", group: "Tabs & panes", default: { code: "KeyD", meta: true, shift: true } },
  { id: "toggleMaximize", label: "Maximize / restore pane", group: "Tabs & panes", default: { code: "KeyM", meta: true } },
  { id: "clearScreen", label: "Clear terminal", group: "Tabs & panes", default: { code: "KeyK", meta: true } },
  { id: "nextTab", label: "Next tab", group: "Tabs & panes", default: { code: "BracketRight", meta: true, shift: true } },
  { id: "prevTab", label: "Previous tab", group: "Tabs & panes", default: { code: "BracketLeft", meta: true, shift: true } },
  { id: "switchTab1", label: "Switch to tab 1", group: "Tabs & panes", default: { code: "Digit1", meta: true } },
  { id: "switchTab2", label: "Switch to tab 2", group: "Tabs & panes", default: { code: "Digit2", meta: true } },
  { id: "switchTab3", label: "Switch to tab 3", group: "Tabs & panes", default: { code: "Digit3", meta: true } },
  { id: "switchTab4", label: "Switch to tab 4", group: "Tabs & panes", default: { code: "Digit4", meta: true } },
  { id: "switchTab5", label: "Switch to tab 5", group: "Tabs & panes", default: { code: "Digit5", meta: true } },
  { id: "switchTab6", label: "Switch to tab 6", group: "Tabs & panes", default: { code: "Digit6", meta: true } },
  { id: "switchTab7", label: "Switch to tab 7", group: "Tabs & panes", default: { code: "Digit7", meta: true } },
  { id: "switchTab8", label: "Switch to tab 8", group: "Tabs & panes", default: { code: "Digit8", meta: true } },
  { id: "switchTab9", label: "Switch to tab 9", group: "Tabs & panes", default: { code: "Digit9", meta: true } },
  { id: "nextPane", label: "Next pane", group: "Tabs & panes", default: { code: "BracketRight", meta: true } },
  { id: "prevPane", label: "Previous pane", group: "Tabs & panes", default: { code: "BracketLeft", meta: true } },
  { id: "newPage", label: "New page", group: "Navigation", default: { code: "KeyN", meta: true } },
  { id: "newChildPage", label: "New child page", group: "Navigation", default: { code: "Enter", meta: true } },
  { id: "newWorkspace", label: "New workspace", group: "Navigation", default: { code: "KeyN", meta: true, shift: true } },
  { id: "previousTheme", label: "Previous theme", group: "Appearance", default: { code: "Comma", meta: true, alt: true } },
  { id: "nextTheme", label: "Next theme", group: "Appearance", default: { code: "Period", meta: true, alt: true } },
  { id: "toggleSidebar", label: "Toggle sidebar", group: "General", default: { code: "KeyB", meta: true } },
  { id: "toggleRail", label: "Toggle quick-action panel", group: "General", default: { code: "KeyJ", meta: true, shift: true } },
  { id: "openSettings", label: "Open settings", group: "General", default: { code: "Comma", meta: true } },
  { id: "search", label: "Search pages, tabs & panels", group: "General", default: { code: "KeyP", meta: true } },
];

/** Codes that are modifiers themselves — never a valid chord on their own. */
const MODIFIER_CODES = new Set([
  "MetaLeft", "MetaRight", "ControlLeft", "ControlRight",
  "ShiftLeft", "ShiftRight", "AltLeft", "AltRight",
]);

const STORAGE_KEY = "termany.keybindings";

/** Default map of action id → chord, derived from ACTIONS. */
export const DEFAULT_KEYBINDINGS: Record<string, Chord> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a.default])
);

function isChord(c: unknown): c is Chord {
  return !!c && typeof (c as Chord).code === "string";
}

/** Persisted bindings merged over defaults, falling back to defaults entirely. */
export function loadKeybindings(): Record<string, Chord> {
  const map = { ...DEFAULT_KEYBINDINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Record<string, unknown>;
      for (const a of ACTIONS) {
        if (isChord(stored[a.id])) map[a.id] = stored[a.id] as Chord;
      }
    }
  } catch {
    /* localStorage blocked / corrupt — fall back to defaults */
  }
  return map;
}

export function saveKeybindings(map: Record<string, Chord>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore persistence failure */
  }
}

/** Does a keydown event satisfy this chord (exact modifier match)? */
export function matchChord(e: KeyboardEvent, c: Chord): boolean {
  return (
    e.code === c.code &&
    e.metaKey === !!c.meta &&
    e.ctrlKey === !!c.ctrl &&
    e.shiftKey === !!c.shift &&
    e.altKey === !!c.alt
  );
}

/** Build a chord from a keydown, or null if only modifiers are held. */
export function chordFromEvent(e: KeyboardEvent): Chord | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  return {
    code: e.code,
    meta: e.metaKey || undefined,
    ctrl: e.ctrlKey || undefined,
    shift: e.shiftKey || undefined,
    alt: e.altKey || undefined,
  };
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  return (
    a.code === b.code &&
    !!a.meta === !!b.meta &&
    !!a.ctrl === !!b.ctrl &&
    !!a.shift === !!b.shift &&
    !!a.alt === !!b.alt
  );
}

/** Human-readable label for a KeyboardEvent.code. */
function codeLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num" + code.slice(6);
  const map: Record<string, string> = {
    Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
    Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
    Backquote: "`", Minus: "-", Equal: "=",
    Enter: "↩", Space: "Space", Tab: "⇥", Backspace: "⌫",
    Delete: "⌦", Escape: "Esc",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  };
  return map[code] ?? code;
}

/** Mac-style display string, e.g. "⌘⇧D". Modifier order: ⌃⌥⇧⌘. */
export function formatChord(c: Chord): string {
  let s = "";
  if (c.ctrl) s += "⌃";
  if (c.alt) s += "⌥";
  if (c.shift) s += "⇧";
  if (c.meta) s += "⌘";
  return s + codeLabel(c.code);
}

/**
 * "<label> (<chord>)" for a button's title/tooltip, reading the action's LIVE
 * binding (so a rebind in Settings → Keyboard is reflected immediately,
 * unlike a hardcoded shortcut string baked into the JSX).
 */
export function withShortcut(label: string, actionId: string): string {
  const chord = loadKeybindings()[actionId];
  return chord ? `${label} (${formatChord(chord)})` : label;
}
