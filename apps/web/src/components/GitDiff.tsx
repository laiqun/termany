import { useEffect } from "react";
import { GitDiffView } from "./GitDiffView";

/**
 * Modal presentation of the diff viewer (⌘⌥G / the command palette), for a
 * quick look without giving up a pane. The pane view is the primary one — see
 * GitDiffView, which both share.
 */
export function GitDiff({ session, onClose }: { session?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="usage-modal" onClick={(e) => e.stopPropagation()}>
        <GitDiffView session={session ?? ""} variant="modal" viewId="modal" />
      </div>
    </div>
  );
}
