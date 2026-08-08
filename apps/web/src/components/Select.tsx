import { useEffect, useRef, useState } from "react";
import { ChevronIcon, TrashIcon } from "./icons";

export interface UsageSelectOption {
  value: string;
  label: string;
  /** Shows the remove button on this row — only when `onRemove` is given. */
  removable?: boolean;
}

/**
 * Themed replacement for a native <select>. A real select renders its popup
 * through the OS, which ignores the control's width (long project paths blow
 * it up) and can't be dark-themed — so the popup is drawn here instead, at the
 * control's own width with per-item ellipsis.
 *
 * Two extensions beyond a plain option list: `actions` are extra rows pinned
 * below the options (a "New…" entry that isn't a selectable value), and
 * options flagged `removable` carry a small always-visible remove button —
 * always visible rather than hover-revealed, because there is no hover on
 * touch screens.
 */
export function UsageSelect({
  value,
  options,
  onChange,
  width,
  actions,
  onRemove,
}: {
  value: string;
  options: UsageSelectOption[];
  onChange: (value: string) => void;
  width: number;
  actions?: Array<{ label: string; onSelect: () => void }>;
  onRemove?: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture on `window` so Escape closes just the menu, firing before any
    // modal's own document-level Escape handler (e.g. Settings) can close the
    // whole overlay.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="usage-select" ref={ref} style={{ width }}>
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
          {options.map((o) => {
            const cls = `usage-select-item ${o.value === value ? "active" : ""}`;
            const pick = () => {
              onChange(o.value);
              setOpen(false);
            };
            // A removable row is two buttons (nested <button>s are invalid):
            // the pick, then the remove affordance at the row's right edge.
            if (onRemove && o.removable) {
              return (
                <div key={o.value} className={cls} title={o.label}>
                  <button className="usage-select-pick" onClick={pick}>
                    {o.label}
                  </button>
                  <button
                    className="usage-select-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      onRemove(o.value);
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              );
            }
            return (
              <button key={o.value} className={cls} title={o.label} onClick={pick}>
                {o.label}
              </button>
            );
          })}
          {actions?.length ? (
            <>
              <div className="usage-select-sep" />
              {actions.map((a) => (
                <button
                  key={a.label}
                  className="usage-select-item usage-select-action"
                  onClick={() => {
                    setOpen(false);
                    a.onSelect();
                  }}
                >
                  {a.label}
                </button>
              ))}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
