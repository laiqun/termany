import { useEffect, useRef, useState } from "react";
import { ChevronIcon } from "./icons";

/**
 * Themed replacement for a native <select>. A real select renders its popup
 * through the OS, which ignores the control's width (long project paths blow
 * it up) and can't be dark-themed — so the popup is drawn here instead, at the
 * control's own width with per-item ellipsis.
 */
export function UsageSelect({
  value,
  options,
  onChange,
  width,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  width: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [open]);

  return (
    <div
      className="usage-select"
      ref={ref}
      style={{ width }}
      onKeyDown={(e) => {
        // Swallow Escape while open so it closes the menu, not the whole modal.
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        className={`usage-select-btn ${open ? "open" : ""}`}
        title={current?.label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <span className="usage-select-label">{current?.label ?? value}</span>
        <ChevronIcon dir="down" />
      </button>
      {open && (
        <div className="usage-select-menu">
          {options.map((o) => (
            <button
              key={o.value}
              className={`usage-select-item ${o.value === value ? "active" : ""}`}
              title={o.label}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
