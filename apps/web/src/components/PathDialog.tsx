import { useEffect, useRef, useState } from "react";
import { apiPath } from "../api";
import { fetchWorktreeScope, resolveDirCwd, type WorktreeScope } from "../fs";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { activeNode, useStore, type PathPrompt } from "../state/store";
import { queueWorktreeSetup } from "../terminal/manager";
import { UsageSelect } from "./Select";

/**
 * Modal "pick a working directory" prompt shown before a page/tab is created
 * (see store.pathPrompt). The input is pre-filled with the directory the new
 * page/tab would have inherited, so accepting the default is a single Enter;
 * Escape cancels the creation entirely. An invalid path flags the input red
 * (Enter keeps the dialog open); an empty input means home.
 *
 * For a new TAB whose directory sits inside a git repo, the dialog also
 * offers to create the tab as a fresh worktree on a new branch (the app's
 * one-tab-per-worktree flow): branch name, the ref to cut it from, and an
 * optional task description — passed to the repo's .termany/setup script,
 * which is typed into the new tab's first shell. The worktree's directory is
 * the server's choice (a sibling of the main checkout).
 */
export function PathDialog() {
  const prompt = useStore((s) => s.pathPrompt);
  if (!prompt) return null;
  // Keyed so a second prompt never inherits the first one's draft.
  return <PathDialogInner key={`${prompt.kind}:${prompt.parentId ?? ""}:${prompt.initial}`} prompt={prompt} />;
}

function PathDialogInner({ prompt }: { prompt: PathPrompt }) {
  const { t } = useI18n();
  const ime = useImeGuard();
  const closePathPrompt = useStore((s) => s.closePathPrompt);
  const [value, setValue] = useState(prompt.initial);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The repo the typed directory lands in — null until the probe says so.
  const [scope, setScope] = useState<WorktreeScope | null>(null);
  const [worktreeOn, setWorktreeOn] = useState(false);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [todo, setTodo] = useState("");
  const branchRef = useRef<HTMLInputElement>(null);
  const scopeRootRef = useRef<string | null>(null);

  // Pages get a plain directory; the worktree offer is the new-tab flow's.
  const canWorktree = prompt.kind === "tab";

  // Probe the typed directory's repo (debounced): the worktree offer appears
  // only when the path actually lands inside one. Switching repos (or leaving
  // one) resets the worktree draft, which named the old repo's branches.
  useEffect(() => {
    if (!canWorktree) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchWorktreeScope(value.trim() || "~").then((probe) => {
        if (cancelled) return;
        const root = probe?.root ?? null;
        if (root !== scopeRootRef.current) {
          scopeRootRef.current = root;
          // Default ON inside a repo — the worktree is the point of the flow;
          // a plain tab in the same directory is the opt-out.
          setWorktreeOn(!!probe);
          setBranch("");
          setTodo("");
          setBase(probe ? (probe.worktrees.find((w) => w.main)?.branch ?? probe.branch) : "");
        }
        setScope(probe);
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value, canWorktree]);

  const commit = async () => {
    if (busy) return;
    // Worktree mode needs a branch name; an Enter that lacks one moves to the
    // branch field rather than failing.
    if (worktreeOn && scope && !branch.trim()) {
      branchRef.current?.focus();
      return;
    }
    setBusy(true);
    const cwd = await resolveDirCwd(value);
    if (cwd === null) {
      setBusy(false);
      setInvalid(true);
      return;
    }
    const s = useStore.getState();
    let target = cwd;
    if (worktreeOn && scope) {
      try {
        const r = await fetch(apiPath("/api/git/worktrees"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // An unset cwd means home — name it explicitly, or the server would
          // fall back to a session's directory.
          body: JSON.stringify({
            cwd: cwd ?? s.homeDir ?? "~",
            branch: branch.trim(),
            base: base || undefined,
          }),
        });
        const data = (await r.json().catch(() => ({}))) as { error?: string; path?: string };
        if (!r.ok || !data.path) throw new Error(data.error ?? String(r.status));
        target = data.path;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
        return;
      }
    }
    if (prompt.kind === "tab") s.addHTab(target);
    else if (prompt.kind === "childPage" && prompt.parentId) s.addChildNode(prompt.parentId, target);
    else s.addRootNode(target);
    if (worktreeOn && scope && target) {
      // addHTab activates the tab it makes; queue the setup for its shell
      // before React mounts the pane's terminal, which consumes it on spawn.
      const node = activeNode(useStore.getState());
      const leaf = node?.htabs.find((h) => h.id === node.activeHTab)?.focused;
      if (leaf) queueWorktreeSetup(leaf, todo);
    }
    closePathPrompt();
  };

  const titleKey =
    prompt.kind === "tab"
      ? "pathPrompt.newTab"
      : prompt.kind === "childPage"
        ? "pathPrompt.newChildPage"
        : "pathPrompt.newPage";

  return (
    <div className="search-backdrop" onClick={closePathPrompt}>
      <div className="path-prompt" onClick={(e) => e.stopPropagation()}>
        <div className="path-prompt-title">{t(titleKey)}</div>
        <input
          className={`path-prompt-input${invalid ? " invalid" : ""}`}
          autoFocus
          value={value}
          placeholder="~"
          spellCheck={false}
          disabled={busy}
          {...ime.props}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setValue(e.target.value);
            setInvalid(false);
            setError("");
          }}
          onKeyDown={(e) => {
            if (ime.handled(e)) return; // the IME is still using this key
            if (e.key === "Enter") void commit();
            else if (e.key === "Escape") closePathPrompt();
          }}
        />
        {canWorktree && scope && (
          <>
            <label className="gd-dialog-check">
              <input
                type="checkbox"
                checked={worktreeOn}
                disabled={busy}
                onChange={(e) => setWorktreeOn(e.target.checked)}
              />
              {t("worktree.createNew")}
            </label>
            {worktreeOn && (
              <>
                <div className="gd-field">
                  <label>{t("worktree.branchName")}</label>
                  <input
                    {...ime.props}
                    ref={branchRef}
                    className="ws-dialog-input"
                    value={branch}
                    spellCheck={false}
                    disabled={busy}
                    onChange={(e) => setBranch(e.target.value)}
                    onKeyDown={(e) => {
                      if (ime.handled(e)) return;
                      if (e.key === "Enter") void commit();
                      else if (e.key === "Escape") closePathPrompt();
                    }}
                  />
                </div>
                <div className="gd-field">
                  <label>{t("worktree.baseBranch")}</label>
                  <UsageSelect
                    value={base}
                    options={scope.refs.map((r) => ({ value: r, label: r }))}
                    onChange={setBase}
                    width={300}
                  />
                </div>
                <div className="gd-field">
                  <label>{t("worktree.taskDescription")}</label>
                  <textarea
                    {...ime.props}
                    className="ws-dialog-input gd-todo"
                    rows={3}
                    value={todo}
                    spellCheck={false}
                    disabled={busy}
                    placeholder={t("worktree.taskDescriptionHint")}
                    onChange={(e) => setTodo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") closePathPrompt();
                    }}
                  />
                </div>
              </>
            )}
          </>
        )}
        {error && <p className="gd-dialog-error">{error}</p>}
        <div className={`path-prompt-foot${invalid ? " invalid" : ""}`}>
          {invalid ? t("pathPrompt.invalid") : t("pathPrompt.hint")}
        </div>
        <div className="ws-dialog-actions">
          <button className="ws-dialog-btn" onClick={closePathPrompt}>
            {t("common.cancel")}
          </button>
          <button
            className="ws-dialog-btn primary"
            disabled={busy || (worktreeOn && !!scope && !branch.trim())}
            onClick={() => void commit()}
          >
            {t("common.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
