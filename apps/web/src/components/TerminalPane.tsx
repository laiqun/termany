import { useEffect, useRef } from "react";
import { attachSession, detachSession, fitSession, focusSession } from "../terminal/manager";

/**
 * Mounts the persistent session DOM node for `id` into this slot. On unmount we
 * only DETACH the node — the session keeps living in the registry so its shell
 * and scrollback survive being backgrounded.
 */
export function TerminalPane({ id }: { id: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    attachSession(id, host);

    // Coalesce resize bursts (window/split-drag fires RO every frame) to ONE fit
    // per animation frame — fit.fit() measures + reflows the grid and sends a PTY
    // resize, so running it per RO callback floods the socket while dragging.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        fitSession(id);
      });
    });
    ro.observe(host);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      detachSession(id, host);
    };
  }, [id]);

  return <div className="term-pane" ref={hostRef} onMouseDown={() => focusSession(id)} />;
}
