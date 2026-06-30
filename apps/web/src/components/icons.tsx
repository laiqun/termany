/**
 * App icons — thin wrappers over lucide-react so every call site keeps the same
 * component name and API (e.g. ChevronIcon's `dir`). Swap the mapping here to
 * restyle the whole app at once.
 */
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronUp,
  File,
  Maximize2,
  Minimize2,
  PanelLeft,
  Pencil,
  Plus,
  Settings,
  SquareTerminal,
  X,
} from "lucide-react";

// Shared sizing — 16px to match the previous custom glyphs.
const base = { size: 16, strokeWidth: 1.75 };

export function PanelIcon() {
  return <PanelLeft {...base} />;
}

export function ChevronIcon({ dir = "right" }: { dir?: "left" | "right" | "up" | "down" }) {
  const C = { left: ChevronLeft, right: ChevronRight, up: ChevronUp, down: ChevronDown }[dir];
  return <C {...base} />;
}

export function CloseIcon() {
  return <X {...base} />;
}

export function PlusIcon() {
  return <Plus {...base} />;
}

/** Diagonal arrows pointing out — enter magnify (fill the tab). */
export function MaximizeIcon() {
  return <Maximize2 {...base} />;
}

/** Diagonal arrows pointing in — exit magnify (restore the split). */
export function RestoreIcon() {
  return <Minimize2 {...base} />;
}

/** Document/page glyph — the leaf marker in the sidebar tree. */
export function PageIcon() {
  return <File {...base} />;
}

/** Pencil — edit action. */
export function EditIcon() {
  return <Pencil {...base} />;
}

/** Gear — settings. */
export function GearIcon() {
  return <Settings {...base} />;
}

/** Terminal in a rounded square — the per-pane header marker. */
export function TerminalIcon() {
  return <SquareTerminal {...base} />;
}

/** Collapse-all glyph (sidebar tree). */
export function CollapseAllIcon() {
  return <ChevronsDownUp {...base} />;
}
