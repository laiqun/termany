import { getCurrentWindow } from "@tauri-apps/api/window";

// A borderless window has no native resize borders, so we lay thin invisible
// handles along every edge/corner that drive Tauri's startResizeDragging.
type Dir =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

const HANDLES: { cls: string; dir: Dir }[] = [
  { cls: "n", dir: "North" },
  { cls: "s", dir: "South" },
  { cls: "e", dir: "East" },
  { cls: "w", dir: "West" },
  { cls: "ne", dir: "NorthEast" },
  { cls: "nw", dir: "NorthWest" },
  { cls: "se", dir: "SouthEast" },
  { cls: "sw", dir: "SouthWest" },
];

export function ResizeHandles() {
  return (
    <>
      {HANDLES.map((h) => (
        <div
          key={h.cls}
          className={`resize-handle ${h.cls}`}
          onMouseDown={(e) => {
            e.preventDefault();
            void getCurrentWindow().startResizeDragging(h.dir);
          }}
        />
      ))}
    </>
  );
}
