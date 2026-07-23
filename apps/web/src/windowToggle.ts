/**
 * OS-wide "summon" shortcut: show/hide the Termany window from any app.
 *
 * The webview's own keybindings (keybindings.ts) only fire while Termany is
 * focused; this one is registered at the OS level on the Rust side, which also
 * persists it so it is active before the webview loads. The chord is captured
 * with the same recorder UI as everything else, then converted to the
 * global-shortcut plugin's string syntax ("alt+Backquote") for Rust.
 *
 * There is deliberately no silent default: every good chord is claimed
 * somewhere (Space combos by Spotlight/Alfred/IMEs, Alt+` by the Windows
 * Japanese IME and GNOME, bare F-keys by the Mac media layer), so the feature
 * is opt-in with a warning list for known conflicts. Registration failures
 * surface in the settings row.
 */
import type { Chord } from "./keybindings";

const IS_MAC = navigator.userAgent.includes("Mac");
const IS_WIN = navigator.userAgent.includes("Windows");

/**
 * Shown while recording, as a starting point for the hardest part of this
 * feature — picking a chord nothing else claims. The least-contested one we
 * know of per platform; on Windows, Win+` matches Windows Terminal's quake
 * mode.
 */
export const SUGGESTED_TOGGLE_CHORD: Chord = IS_MAC
  ? { code: "Backquote", alt: true }
  : IS_WIN
    ? { code: "Backquote", meta: true }
    : { code: "Backquote", ctrl: true, alt: true };

/** Chord → the global-shortcut plugin's parse syntax, e.g. "alt+Backquote". */
export function chordToGlobalShortcut(c: Chord): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push("control");
  if (c.alt) parts.push("alt");
  if (c.shift) parts.push("shift");
  if (c.meta) parts.push("super");
  parts.push(c.code);
  return parts.join("+");
}

/** Inverse of chordToGlobalShortcut, for displaying the stored shortcut. */
export function globalShortcutToChord(s: string): Chord | null {
  const parts = s.split("+");
  const code = parts.pop();
  if (!code) return null;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return {
    code,
    ctrl: mods.has("control") || mods.has("ctrl") || undefined,
    alt: mods.has("alt") || mods.has("option") || undefined,
    shift: mods.has("shift") || undefined,
    meta: mods.has("super") || mods.has("cmd") || mods.has("command") || undefined,
  };
}

export async function getWindowToggleShortcut(): Promise<Chord | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const s = await invoke<string | null>("get_window_toggle_shortcut");
  return s ? globalShortcutToChord(s) : null;
}

/** Registers (or, with null, unregisters) the shortcut. Rejects when the OS
 * refuses the registration — typically another app's global hotkey. */
export async function setWindowToggleShortcut(chord: Chord | null): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_window_toggle_shortcut", {
    shortcut: chord ? chordToGlobalShortcut(chord) : null,
  });
}

/**
 * Known silent conflicts. Registration failure only catches chords some other
 * app also registered globally (the "loud" conflicts); stealing a key from an
 * IME or from another app's in-app shortcut produces no error at all — this
 * list is the only place those get flagged. Non-blocking: the user may know
 * better (e.g. no Japanese IME on their machine).
 */
export function globalShortcutWarning(
  c: Chord
): { key: string; params?: Record<string, string> } | null {
  const mods =
    (c.ctrl ? 1 : 0) | (c.alt ? 2 : 0) | (c.shift ? 4 : 0) | (c.meta ? 8 : 0);
  if (c.code === "Space") {
    if (mods === 1) return { key: "kb.global.warn.inputSource" };
    if (mods === 2) return { key: "kb.global.warn.altSpace" };
    if (mods === 4) return { key: "kb.global.warn.imeWidth" };
    if (mods === 8) return { key: "kb.global.warn.taken", params: { name: "Spotlight" } };
    if (mods === 10) return { key: "kb.global.warn.taken", params: { name: "Finder" } };
    if (mods === 12) return { key: "kb.global.warn.taken", params: { name: "1Password" } };
  }
  if (c.code === "Backquote") {
    if (mods === 1 || mods === 5)
      return { key: "kb.global.warn.taken", params: { name: "VS Code" } };
    if (mods === 2 && !IS_MAC) return { key: "kb.global.warn.altBackquote" };
  }
  if (mods === 0 && /^F\d{1,2}$/.test(c.code)) return { key: "kb.global.warn.fnKey" };
  return null;
}
