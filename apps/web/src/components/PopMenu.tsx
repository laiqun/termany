import { useEffect, useId, useRef, useState } from "react";
import { registerOccluder, unregisterOccluder } from "../nativeViewOcclusion";
import { CheckIcon, ChevronIcon } from "./icons";

/** Breathing room kept between a flown-out submenu and the edge that clips it. */
const EDGE_MARGIN = 8;

/**
 * The box a submenu is actually free to occupy.
 *
 * Not the window: a pane is an `overflow: hidden` slot, so a flyout that leaves
 * it is silently cut off — visible as model names missing their first few
 * characters — while still measuring as comfortably on screen.
 */
function clipBounds(el: HTMLElement): { left: number; right: number; top: number; bottom: number } {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }
  }
  const root = document.documentElement;
  return { left: 0, right: root.clientWidth, top: 0, bottom: root.clientHeight };
}

/** How far one edge of `rect` sits outside `[low, high]`, as a correction. */
function slideInto(start: number, end: number, low: number, high: number): number {
  if (start < low + EDGE_MARGIN) return low + EDGE_MARGIN - start;
  if (end > high - EDGE_MARGIN) return high - EDGE_MARGIN - end;
  return 0;
}

/** Fit an open submenu inside that box: shrink it if it must, then slide it in. */
function fitSubmenu(sub: HTMLElement): void {
  // Cleared first so the stylesheet's own caps are what gets measured — the
  // correction is then computed from scratch every time instead of compounding
  // whatever the last opening left behind.
  sub.style.maxWidth = "";
  sub.style.maxHeight = "";
  sub.style.transform = "";
  const bounds = clipBounds(sub);
  const styled = getComputedStyle(sub);
  const room = (span: number, styledMax: string) =>
    Math.max(Math.min(parseFloat(styledMax) || Infinity, span - EDGE_MARGIN * 2), 120);
  sub.style.maxWidth = `${room(bounds.right - bounds.left, styled.maxWidth)}px`;
  sub.style.maxHeight = `${room(bounds.bottom - bounds.top, styled.maxHeight)}px`;

  const rect = sub.getBoundingClientRect();
  const dx = Math.round(slideInto(rect.left, rect.right, bounds.left, bounds.right));
  const dy = Math.round(slideInto(rect.top, rect.bottom, bounds.top, bounds.bottom));
  if (dx || dy) sub.style.transform = `translate(${dx}px, ${dy}px)`;
}

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
  onOpen,
  onSelect,
}: {
  label: string;
  ariaLabel: string;
  disabled?: boolean;
  items: PopMenuItem[];
  footer?: { label: string; onSelect: () => void };
  side?: "left" | "right";
  /** Fired as the panel opens, for menus whose contents have to be fetched.
   *  Opening is the earliest honest signal of intent — filling the menu ahead
   *  of time would mean paying for it in every pane that never opens it. */
  onOpen?: () => void;
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
  //
  // The same pass fits an open submenu inside the pane. `side` says which way
  // the flyout goes, but not whether there is room: a pane split narrow, or a
  // list of long model names, pushes it past the edge that clips it.
  useEffect(() => {
    if (!open) {
      setOpenSub("");
      return;
    }
    const panelId = `${occluderId}-panel`;
    const subId = `${occluderId}-sub`;
    const update = () => {
      if (panelRef.current) registerOccluder(panelId, panelRef.current.getBoundingClientRect());
      if (!subRef.current) {
        unregisterOccluder(subId);
        return;
      }
      fitSubmenu(subRef.current);
      registerOccluder(subId, subRef.current.getBoundingClientRect());
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
        onClick={() =>
          setOpen((was) => {
            if (!was) onOpen?.();
            return !was;
          })
        }
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
