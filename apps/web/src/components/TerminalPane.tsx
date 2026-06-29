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

    const ro = new ResizeObserver(() => fitSession(id));
    ro.observe(host);

    return () => {
      ro.disconnect();
      detachSession(id, host);
    };
  }, [id]);

  return <div className="term-pane" ref={hostRef} onMouseDown={() => focusSession(id)} />;
}
