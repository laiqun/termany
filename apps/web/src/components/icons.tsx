import type { ReactNode } from "react";

/** Sidebar-panel toggle glyph (rounded rect with a left divider, Notion-style). */
export function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <line x1="6.2" y1="3" x2="6.2" y2="13" />
    </svg>
  );
}

export function ChevronIcon({ dir = "right" }: { dir?: "left" | "right" | "up" | "down" }) {
  const points = {
    left: "10 4 6 8 10 12",
    right: "6 4 10 8 6 12",
    up: "4 10 8 6 12 10",
    down: "4 6 8 10 12 6",
  }[dir];
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points={points} />
    </svg>
  );
}

/** Shared geometry for the single-stroke glyph icons below. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function CloseIcon() {
  return <Glyph><path d="M4 4l8 8M12 4l-8 8" /></Glyph>;
}

export function PlusIcon() {
  return <Glyph><path d="M8 3.5v9M3.5 8h9" /></Glyph>;
}

/** Diagonal arrows pointing out — enter magnify (fill the tab). */
export function MaximizeIcon() {
  return (
    <Glyph>
      <path d="M9 3h4v4" />
      <path d="M7 13H3V9" />
      <path d="M13 3l-4.5 4.5" />
      <path d="M3 13l4.5-4.5" />
    </Glyph>
  );
}

/** Document/page glyph — the leaf marker in the sidebar tree (Notion-style). */
export function PageIcon() {
  return (
    <Glyph>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
    </Glyph>
  );
}

/** Pencil — edit action. */
export function EditIcon() {
  return (
    <Glyph>
      <path d="M10.5 2.8l2.7 2.7L6 12.7H3.3v-2.7z" />
      <line x1="9.3" y1="4" x2="12" y2="6.7" />
    </Glyph>
  );
}

/** Gear — settings. */
export function GearIcon() {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2M3.5 3.5l1.5 1.5M11 11l1.5 1.5M12.5 3.5L11 5M5 11l-1.5 1.5" />
    </Glyph>
  );
}

/** Terminal window with a prompt — the per-pane header marker. */
export function TerminalIcon() {
  return (
    <Glyph>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M5 7l2 1.5-2 1.5" />
      <line x1="8.5" y1="10" x2="11" y2="10" />
    </Glyph>
  );
}

/** Collapse-all glyph — a box with a dash (VS Code explorer style). */
export function CollapseAllIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    >
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
      <line x1="5" y1="8" x2="11" y2="8" />
    </svg>
  );
}

/** Diagonal arrows pointing in — exit magnify (restore the split). */
export function RestoreIcon() {
  return (
    <Glyph>
      <path d="M13 7H9V3" />
      <path d="M3 9h4v4" />
      <path d="M9 7l4-4" />
      <path d="M7 9l-4 4" />
    </Glyph>
  );
}
