import { useEffect, useId, useRef, useState } from "react";
import { registerOccluder, unregisterOccluder } from "../nativeViewOcclusion";
import { CheckIcon, ChevronIcon } from "./icons";

export interface PopMenuItem {
  id: string;
  label: string;
  checked?: boolean;
  /** Present (even if empty) to make this row a submenu parent instead of a choice. */
  items?: PopMenuItem[];
}

/**
 * Composer dropdown with one level of submenus: the parent panel opens above
 * its trigger, submenus fly out sideways from the hovered row, and a pinned
 * footer row jumps to the matching Settings section.
 *
 * `side` is fixed by the caller rather than measured, because both callers sit
 * at a known end of the composer bar — the agent picker hugs the left edge so
 * its submenus open right, the model picker hugs the right so they open left.
 */
export function PopMenu({
  label,
  ariaLabel,
  disabled,
  items,
  footer,
  side = "left",
  onSelect,
}: {
  label: string;
  ariaLabel: string;
  disabled?: boolean;
  items: PopMenuItem[];
  footer?: { label: string; onSelect: () => void };
  side?: "left" | "right";
  onSelect: (id: string) => void;
}) {
  const occluderId = useId();
  const [open, setOpen] = useState(false);
  const [openSub, setOpenSub] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Swallow it so the pane/modal underneath doesn't also react.
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Blank only the web/office preview panes these popups actually cover — native
  // views paint above the DOM and ignore z-index (see nativeViewOcclusion).
  useEffect(() => {
    if (!open) {
      setOpenSub("");
      return;
    }
    const panelId = `${occluderId}-panel`;
    const subId = `${occluderId}-sub`;
    const update = () => {
      if (panelRef.current) registerOccluder(panelId, panelRef.current.getBoundingClientRect());
      if (subRef.current) registerOccluder(subId, subRef.current.getBoundingClientRect());
      else unregisterOccluder(subId);
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      unregisterOccluder(panelId);
      unregisterOccluder(subId);
    };
  }, [open, openSub, occluderId]);

  const choose = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <div className={`pop-menu pop-menu-${side}`} ref={rootRef}>
      <button
        type="button"
        className={`pop-trigger ${open ? "open" : ""}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="pop-trigger-label">{label}</span>
        <ChevronIcon dir="down" />
      </button>
      {open && (
        <div className="pop-panel" role="menu" ref={panelRef}>
          {items.map((item) => (
            <div
              key={item.id}
              className="pop-row"
              onMouseEnter={() => setOpenSub(item.items ? item.id : "")}
            >
              <button
                type="button"
                role="menuitem"
                className={`pop-item ${openSub === item.id ? "active" : ""}`}
                onClick={() => (item.items ? setOpenSub(item.id) : choose(item.id))}
              >
                <span className="pop-item-label">{item.label}</span>
                {item.checked && <CheckIcon />}
                {item.items && <ChevronIcon dir="right" />}
              </button>
              {item.items && openSub === item.id && (
                <div className="pop-sub" role="menu" ref={subRef}>
                  {item.items.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      role="menuitem"
                      className={`pop-item ${child.checked ? "checked" : ""}`}
                      onClick={() => choose(child.id)}
                    >
                      <span className="pop-item-label">{child.label}</span>
                      {child.checked && <CheckIcon />}
                    </button>
                  ))}
                  {item.items.length === 0 && <div className="pop-empty">—</div>}
                </div>
              )}
            </div>
          ))}
          {footer && (
            <>
              <div className="pop-sep" />
              <button
                type="button"
                role="menuitem"
                className="pop-item"
                onClick={() => {
                  setOpen(false);
                  footer.onSelect();
                }}
              >
                <span className="pop-item-label">{footer.label}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
