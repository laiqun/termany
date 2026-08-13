import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "../api";
import { fetchWorktreeScope, inDir, sameDir } from "../fs";
import { useI18n } from "../i18n";
import { useNativeOccluder } from "../nativeViewOcclusion";
import { countMatchingHTabs } from "../state/htabs";
import { useStore, type HTab } from "../state/store";

interface PendingClose {
  tabId: string;
  worktree: { path: string; name: string; branch: string; detached?: boolean };
  /** Uncommitted files the deletion takes with the directory. */
  files: number;
  /** OTHER tabs pointing into the same worktree — they close too. */
  others: number;
}

/**
 * Tab closing with the one-tab-per-worktree deal attached: closing a tab
 * whose cwd is a linked worktree deletes that worktree — its directory AND
 * its branch — so the close button asks first (and says what else goes with
 * it: uncommitted files, other tabs pointed there). A tab in the main
 * checkout, a subdirectory of it, or nowhere near a repo closes silently,
 * exactly as before.
 */
export function useWorktreeTabClose() {
  const [pending, setPending] = useState<PendingClose | null>(null);
  const probingRef = useRef(false);

  const requestClose = useCallback(async (tab: HTab) => {
    const closeHTab = useStore.getState().closeHTab;
    if (!tab.cwd) {
      closeHTab(tab.id);
      return;
    }
    if (probingRef.current) return;
    probingRef.current = true;
    try {
      const scope = await fetchWorktreeScope(tab.cwd, { files: true });
      // The repo root of the tab's cwd IS its worktree's path when the tab
      // sits inside a linked worktree; anything else closes without asking.
      const wt = scope?.worktrees.find((w) => sameDir(w.path, scope.root));
      if (!scope || !wt || wt.main) {
        closeHTab(tab.id);
        return;
      }
      const others =
        useStore
          .getState()
          .workspaces.reduce((n, ws) => n + countMatchingHTabs(ws.roots, (dir) => inDir(wt.path, dir)), 0) - 1;
      setPending({ tabId: tab.id, worktree: wt, files: scope.files ?? 0, others });
    } finally {
      probingRef.current = false;
    }
  }, []);

  const dialog = pending ? <CloseWorktreeTabDialog pending={pending} onClose={() => setPending(null)} /> : null;
  return { requestClose, dialog };
}

function CloseWorktreeTabDialog({ pending, onClose }: { pending: PendingClose; onClose: () => void }) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const backdropRef = useNativeOccluder<HTMLDivElement>("close-worktree-tab");
  const { worktree } = pending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    // Tabs pointed at the doomed directory (or anywhere under it) close
    // first: their shells would hold the directory open — Windows refuses
    // the move-aside while one does — and they'd be left on a path that no
    // longer exists.
    useStore.getState().closeHTabsWhere((dir) => inDir(worktree.path, dir));
    const params = new URLSearchParams({ worktree: worktree.path, cwd: worktree.path });
    if (!worktree.detached) params.set("branch", "1");
    try {
      const r = await fetch(apiPath(`/api/git/worktrees?${params}`), { method: "DELETE" });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? String(r.status));
      onClose();
    } catch (e) {
      // The tabs are already gone; the worktree survived — say why.
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="ws-dialog-backdrop" ref={backdropRef} onClick={onClose}>
      <div className="ws-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="quit-confirm-text">
          {worktree.detached
            ? t("worktree.closeConfirmDetached", { name: worktree.name })
            : t("worktree.closeConfirm", { name: worktree.name, branch: worktree.branch })}
        </p>
        {pending.files > 0 && <p className="gd-dialog-warn">{t("worktree.dirty", { files: pending.files })}</p>}
        {pending.others > 0 && <p className="gd-dialog-warn">{t("worktree.closeOthers", { count: pending.others })}</p>}
        {error && <p className="gd-dialog-error">{error}</p>}
        <div className="ws-dialog-actions">
          <button className="ws-dialog-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="ws-dialog-btn danger" disabled={busy} onClick={() => void submit()}>
            {t("worktree.closeAndDelete")}
          </button>
        </div>
      </div>
    </div>
  );
}
