import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { useNativeOccluder } from "../nativeViewOcclusion";
import { activeNode, useStore } from "../state/store";
import { prewarmSession, queueWorktreeSetup } from "../terminal/manager";
import { CheckIcon, ChevronIcon, CopyIcon, GitBranchIcon, GitCompareIcon, RefreshIcon } from "./icons";
import { UsageSelect } from "./Select";

export type Section = "staged" | "unstaged" | "untracked" | "changed";

interface GitRow {
  path: string;
  oldPath?: string;
  section: Section;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  isDir?: boolean;
}

interface GitWorktree {
  path: string;
  name: string;
  branch: string;
  detached?: boolean;
  main: boolean;
  files: number;
}

type Overview =
  | { repo: false; cwd: string }
  | {
      repo: true;
      cwd: string;
      root: string;
      branch: string;
      base?: string;
      refs: string[];
      rows: GitRow[];
      overflow?: boolean;
      worktrees?: GitWorktree[];
    };

interface DiffPayload {
  diff: string;
  binary?: boolean;
  truncated?: boolean;
}

/** Sentinel for "no base ref" in the compare picker, which needs a string. */
const WORKING_TREE = "";
/**
 * `null` for either selection means "server's choice": no worktree pins the
 * panel to whichever one the terminal is in, and no base lets the server pick
 * the fork a linked worktree should be measured from. Both become a real value
 * the moment the user picks one, and the request then always carries it — an
 * absent parameter and an empty one mean different things to the endpoint.
 */
type Auto = null;

/**
 * How much diff to open on arrival. Budgeting by LINES rather than by file
 * count is what keeps a compare of fifteen 4000-line files from laying down a
 * quarter-million DOM nodes before you have scrolled anywhere. The file cap
 * backs it up for untracked entries, whose size isn't known until fetched.
 */
const AUTO_EXPAND_LINES = 3000;
const AUTO_EXPAND_FILES = 50;

type LineKind = "add" | "del" | "meta" | "hunk" | "ctx";

interface DiffLine {
  kind: LineKind;
  text: string;
  /** Line number on the old side, blank for additions. */
  oldNo?: number;
  /** Line number on the new side, blank for deletions. */
  newNo?: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Classify unified-diff lines and walk the two line counters, so each row can
 * show its old and new line numbers the way a review UI does. The `diff --git`
 * / `index` / `--- +++` preamble is dropped: the card header already names the
 * file, and repeating it costs four lines before every hunk.
 */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split("\n")) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      out.push({ kind: "hunk", text: line });
      continue;
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to")
    ) {
      continue;
    }
    if (line.startsWith("+")) out.push({ kind: "add", text: line, newNo: newNo++ });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line, oldNo: oldNo++ });
    else if (line.startsWith("\\")) out.push({ kind: "meta", text: line });
    else out.push({ kind: "ctx", text: line, oldNo: oldNo++, newNo: newNo++ });
  }
  // A diff ends with a newline, so the split leaves a trailing blank.
  while (out.length && out[out.length - 1].kind === "ctx" && !out[out.length - 1].text) out.pop();
  return out;
}

const rowKey = (r: GitRow) => `${r.section}:${r.path}`;

/**
 * Directory spelling never carries meaning: `\` vs `/`, a trailing slash, and
 * — when a drive letter says Windows — case.
 */
function normDir(p: string): string {
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(n) ? n.toLowerCase() : n;
}

/** Directory comparison for matching a worktree's root against a tab's cwd. */
function sameDir(a: string, b: string): boolean {
  return normDir(a) === normDir(b);
}

/** True when `dir` is `root` itself or somewhere beneath it. */
function inDir(root: string, dir: string): boolean {
  const r = normDir(root);
  const d = normDir(dir);
  return d === r || d.startsWith(r + "/");
}

interface CachedView {
  base: string | Auto;
  worktree: string | Auto;
  cwd: string | Auto;
  collapsed: Record<string, boolean>;
  diffs: Record<string, DiffPayload>;
  overview: Overview | null | undefined;
  scrollTop: number;
}

/**
 * View state lives outside React, keyed by pane, because the pane's React tree
 * position is not stable: zen mode portals it to <body>, and dragging it to
 * another tab re-parents it. Both unmount and remount this component, which
 * would otherwise throw away the compare selection, the collapse toggles, the
 * fetched diffs and the scroll offset every time. Terminal panes survive the
 * same churn the same way — see attachSession in terminal/manager.
 */
const viewCache = new Map<string, CachedView>();
/** Bounded so closed panes can't retain their diffs for the session's lifetime. */
const MAX_CACHED_VIEWS = 8;

function remember(viewId: string, patch: Partial<CachedView>) {
  const prev = viewCache.get(viewId);
  if (!prev && viewCache.size >= MAX_CACHED_VIEWS) {
    viewCache.delete(viewCache.keys().next().value as string);
  }
  viewCache.set(viewId, {
    base: null,
    worktree: null,
    cwd: null,
    collapsed: {},
    diffs: {},
    overview: undefined,
    scrollTop: 0,
    ...prev,
    ...patch,
  });
}

/**
 * One file's card. The diff is handed down rather than fetched here: the
 * parent asks for every expanded file in a single request, so a refresh
 * refreshes the bodies too (a per-card fetch keyed on the path would keep
 * showing the old diff after the file changed underneath it).
 */
function FileCard({
  row,
  diff,
  expanded,
  onToggle,
}: {
  row: GitRow;
  diff: DiffPayload | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const skip = row.binary || row.isDir;
  const lines = useMemo(() => (diff?.diff ? parseDiff(diff.diff) : []), [diff]);
  const dir = row.path.replace(/[^/]+$/, "");
  const name = row.path.split("/").pop();
  const [copied, setCopied] = useState(false);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(row.path);
      setCopied(true);
      // Flip the icon back so a second copy still reads as one.
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard denied (insecure origin / no permission) — leave the icon as is.
    }
  };

  return (
    <div className={`gd-card ${expanded ? "open" : ""}`}>
      {/* The head is a div rather than one big button so the copy control can
          sit beside the toggle — buttons can't nest. */}
      <div className="gd-card-head">
        <button
          className="gd-copy"
          title={t("gitdiff.copyPath")}
          aria-label={t("gitdiff.copyPath")}
          onClick={() => void copyPath()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <button className="gd-card-toggle" onClick={onToggle} aria-expanded={expanded}>
          <span className={`gd-chevron ${expanded ? "open" : ""}`}>
            <ChevronIcon dir="right" />
          </span>
          <span className={`gd-status s-${row.status}`}>{row.status}</span>
          <span className="gd-path">
            <em>{dir}</em>
            <b>{name}</b>
          </span>
          {row.oldPath && <span className="gd-renamed">{t("gitdiff.renamedFrom", { path: row.oldPath })}</span>}
          {!row.binary && (row.additions > 0 || row.deletions > 0) && (
            <span className="gd-counts">
              <em className="add">+{row.additions}</em>
              <em className="del">−{row.deletions}</em>
            </span>
          )}
        </button>
      </div>

      {expanded && (
        <div className="gd-card-body">
          {row.isDir && <div className="gd-note">{t("gitdiff.directory")}</div>}
          {row.binary && <div className="gd-note">{t("gitdiff.binary")}</div>}
          {!skip && !diff && <div className="gd-note">{t("gitdiff.loading")}</div>}
          {!skip && diff?.binary && <div className="gd-note">{t("gitdiff.binary")}</div>}
          {!skip && diff && !diff.binary && lines.length === 0 && (
            <div className="gd-note">{t("gitdiff.empty")}</div>
          )}
          {!skip && diff && !diff.binary && lines.length > 0 && (
            <>
              <div className="gd-code">
                {lines.map((line, i) => (
                  <div key={i} className={`gd-line ${line.kind}`}>
                    <span className="gd-ln">{line.oldNo ?? ""}</span>
                    <span className="gd-ln">{line.newNo ?? ""}</span>
                    <span className="gd-text">{line.text || " "}</span>
                  </div>
                ))}
              </div>
              {diff.truncated && <div className="gd-note">{t("gitdiff.truncated")}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Close on Escape, the way the app's other small dialogs do. Capture phase +
 * stopPropagation so the ⌘⌥G modal's own Escape handler (bubble) doesn't
 * close the whole panel along with the dialog; an open select menu inside the
 * dialog gets the key first instead.
 */
function useEscapeToClose(
  ref: RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (ref.current?.querySelector(".usage-select-menu")) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ref, onClose]);
}

/**
 * "New worktree…" from the worktree switcher. Fields: the new branch name and
 * the ref to cut it from, plus two optional extras — a task description
 * (passed to the repo's .termany/setup script as its first argument) and
 * whether to open a tab for the worktree once created. The directory is the
 * server's choice (a sibling of the main checkout). Creation itself runs
 * nothing: the setup script is typed into the opened tab's terminal instead,
 * so a slow bootstrap (pnpm install) never blocks this dialog.
 */
function NewWorktreeDialog({
  refs,
  defaultBase,
  onCreate,
  onClose,
}: {
  refs: string[];
  defaultBase: string;
  onCreate: (branch: string, base: string, opts: { todo: string; openTab: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ime = useImeGuard();
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState(defaultBase);
  const [todo, setTodo] = useState("");
  const [openTab, setOpenTab] = useState(() => {
    try {
      return localStorage.getItem("termany.worktreeOpenTab") !== "0";
    } catch {
      return true;
    }
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const backdropRef = useNativeOccluder<HTMLDivElement>("gd-new-worktree");
  useEscapeToClose(backdropRef, onClose);

  const submit = async () => {
    const name = branch.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await onCreate(name, base, { todo, openTab });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const toggleOpenTab = (checked: boolean) => {
    setOpenTab(checked);
    try {
      localStorage.setItem("termany.worktreeOpenTab", checked ? "1" : "0");
    } catch {
      /* private mode — remembering the checkbox is a nicety */
    }
  };

  return (
    <div className="ws-dialog-backdrop" ref={backdropRef} onClick={onClose}>
      <div className="ws-dialog gd-wide" onClick={(e) => e.stopPropagation()}>
        <div className="gd-field">
          <label>{t("gitdiff.branchName")}</label>
          <input
            {...ime.props}
            className="ws-dialog-input"
            autoFocus
            value={branch}
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setBranch(e.target.value)}
            onKeyDown={(e) => {
              if (ime.handled(e)) return;
              if (e.key === "Enter") void submit();
              else if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div className="gd-field">
          <label>{t("gitdiff.baseBranch")}</label>
          <UsageSelect
            value={base}
            options={refs.map((r) => ({ value: r, label: r }))}
            onChange={setBase}
            width={260}
          />
        </div>
        <div className="gd-field">
          <label>{t("gitdiff.taskDescription")}</label>
          <textarea
            {...ime.props}
            className="ws-dialog-input gd-todo"
            rows={5}
            value={todo}
            spellCheck={false}
            disabled={busy}
            placeholder={t("gitdiff.taskDescriptionHint")}
            onChange={(e) => setTodo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <label className="gd-dialog-check">
          <input
            type="checkbox"
            checked={openTab}
            disabled={busy}
            onChange={(e) => toggleOpenTab(e.target.checked)}
          />
          {t("gitdiff.openTabAfterCreate")}
        </label>
        {error && <p className="gd-dialog-error">{error}</p>}
        <div className="ws-dialog-actions">
          <button className="ws-dialog-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="ws-dialog-btn primary"
            disabled={!branch.trim() || busy}
            onClick={() => void submit()}
          >
            {t("gitdiff.createWorktree")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Confirms removing a linked worktree. A dirty worktree (its changed-files
 * badge is shown right in the switcher) gets a warning line, since removal
 * discards those changes along with the directory. The "also delete branch"
 * check (pre-checked: these worktrees are throwaway) takes the branch with
 * the directory; a detached worktree has no branch, so the check is hidden
 * there.
 */
function RemoveWorktreeDialog({
  worktree,
  onRemove,
  onClose,
}: {
  worktree: GitWorktree;
  onRemove: (worktree: GitWorktree, withBranch: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [withBranch, setWithBranch] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const backdropRef = useNativeOccluder<HTMLDivElement>("gd-remove-worktree");
  useEscapeToClose(backdropRef, onClose);
  const dirty = worktree.files > 0;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onRemove(worktree, withBranch && !worktree.detached);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="ws-dialog-backdrop" ref={backdropRef} onClick={onClose}>
      <div className="ws-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="quit-confirm-text">{t("gitdiff.removeWorktreeConfirm", { name: worktree.name })}</p>
        {dirty && <p className="gd-dialog-warn">{t("gitdiff.removeWorktreeDirty", { files: worktree.files })}</p>}
        {!worktree.detached && (
          <label className="gd-dialog-check">
            <input type="checkbox" checked={withBranch} onChange={(e) => setWithBranch(e.target.checked)} />
            {t("gitdiff.removeWorktreeBranch", { name: worktree.branch })}
          </label>
        )}
        {error && <p className="gd-dialog-error">{error}</p>}
        <div className="ws-dialog-actions">
          <button className="ws-dialog-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="ws-dialog-btn danger" disabled={busy} onClick={() => void submit()}>
            {t("gitdiff.removeWorktree")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Confirms deleting a branch from the compare picker. The safe delete
 * (`git branch -d`) refuses a branch that isn't fully merged; that refusal
 * comes back flagged, and only then is the "delete anyway" check shown — it
 * maps to `-D`, so a stray click can't take unmerged commits with it.
 */
function DeleteBranchDialog({
  branch,
  onDelete,
  onClose,
}: {
  branch: string;
  onDelete: (branch: string, force: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [force, setForce] = useState(false);
  const [unmerged, setUnmerged] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const backdropRef = useNativeOccluder<HTMLDivElement>("gd-delete-branch");
  useEscapeToClose(backdropRef, onClose);

  const submit = async () => {
    if (busy || (unmerged && !force)) return;
    setBusy(true);
    try {
      await onDelete(branch, force);
      onClose();
    } catch (e) {
      // The not-merged refusal swaps the raw git error for a localized warning
      // plus the force check; anything else (checked out somewhere, say) is
      // shown as it came.
      if ((e as { notMerged?: boolean }).notMerged) {
        setUnmerged(true);
        setError("");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setBusy(false);
    }
  };

  return (
    <div className="ws-dialog-backdrop" ref={backdropRef} onClick={onClose}>
      <div className="ws-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="quit-confirm-text">{t("gitdiff.deleteBranchConfirm", { name: branch })}</p>
        {unmerged && (
          <>
            <p className="gd-dialog-warn">{t("gitdiff.deleteBranchUnmerged")}</p>
            <label className="gd-dialog-check">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              {t("gitdiff.forceRemove")}
            </label>
          </>
        )}
        {error && <p className="gd-dialog-error">{error}</p>}
        <div className="ws-dialog-actions">
          <button className="ws-dialog-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="ws-dialog-btn danger"
            disabled={busy || (unmerged && !force)}
            onClick={() => void submit()}
          >
            {t("gitdiff.deleteBranch")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Git diff viewer for the repo containing the tab's working directory
 * (`tabCwd`; unset resolves server-side to home). The toolbar's address bar
 * shows where the panel landed and accepts a typed path to override it
 * (empty reverts to the tab's directory).
 * Renders as a pane view (the SideRail branch button) or inside the ⌘⌥G
 * modal — same body, the variant only changes the frame. Files are listed
 * GitHub-style: one expandable card each, with its unified diff and old/new
 * line gutters inline.
 *
 * The compare picker switches between the working tree (staged / unstaged /
 * untracked, the default) and "what this branch changes vs <branch>", measured
 * from the merge base — see /api/git/overview.
 */
export function GitDiffView({
  tabCwd,
  variant,
  viewId,
}: {
  /** The tab's fixed working directory — the explicit dir every request
   *  names, which the server gives priority over any session resolution. */
  tabCwd?: string;
  variant: "pane" | "modal";
  /** Stable identity for the cached view state — the leaf id for a pane. */
  viewId: string;
}) {
  const { t } = useI18n();
  const ime = useImeGuard();
  const cached = viewCache.get(viewId);
  const [overview, setOverview] = useState<Overview | null | undefined>(cached?.overview);
  const [base, setBase] = useState<string | Auto>(cached?.base ?? null);
  const [worktree, setWorktree] = useState<string | Auto>(cached?.worktree ?? null);
  // Directory the user typed into the address bar; null follows the tab's cwd.
  const [cwd, setCwd] = useState<string | Auto>(cached?.cwd ?? null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(cached?.collapsed ?? {});
  const [diffs, setDiffs] = useState<Record<string, DiffPayload>>(cached?.diffs ?? {});
  const filesRef = useRef<HTMLDivElement>(null);
  // Bumped on every reload so the diff bodies refetch even when the file list
  // came back identical — the whole point of a refresh is that the CONTENTS
  // moved, which nothing in the row identity would reflect.
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      const dir = cwd ?? tabCwd; // the address bar's pick wins over the tab's cwd
      if (dir) params.set("cwd", dir);
      if (base !== null) params.set("base", base);
      if (worktree !== null) params.set("worktree", worktree);
      const r = await fetch(apiPath(`/api/git/overview?${params}`));
      if (!r.ok) throw new Error(String(r.status));
      setOverview((await r.json()) as Overview);
      setRevision((n) => n + 1);
    } catch {
      setOverview(null);
    }
  }, [tabCwd, base, worktree, cwd]);

  useEffect(() => {
    load();
  }, [load]);

  // Re-check on window focus: the point of the panel is reading what the agent
  // in the terminal just changed, and those changes land while it's open.
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  useEffect(() => {
    remember(viewId, { overview, base, worktree, cwd, collapsed, diffs });
  }, [viewId, overview, base, worktree, cwd, collapsed, diffs]);

  /**
   * The compare actually in force: the user's pick, else whatever the server
   * chose for this worktree. Everything downstream — the picker's value, the
   * diff request, the section label — reads this rather than `base`, so an
   * auto-picked fork behaves exactly like one the user selected.
   */
  const shownBase = base ?? (overview?.repo ? overview.base ?? WORKING_TREE : WORKING_TREE);

  /**
   * Point the panel at another worktree. The compare goes back to automatic
   * because a fork branch is per-worktree, and the diff bodies are dropped
   * because they are keyed by section and path, which say nothing about which
   * worktree they were read from.
   */
  const selectWorktree = useCallback((next: string) => {
    setWorktree(next);
    setBase(null);
    setCollapsed({});
    setDiffs({});
  }, []);

  /**
   * Point the panel at a typed directory (the address bar). Everything scoped
   * to the old directory goes back to automatic for the same reason as a
   * worktree switch; null hands the panel back to the tab's cwd.
   */
  const selectCwd = useCallback((next: string | Auto) => {
    setCwd(next);
    setWorktree(null);
    setBase(null);
    setCollapsed({});
    setDiffs({});
  }, []);

  const setActiveHTab = useStore((s) => s.setActiveHTab);
  const addHTab = useStore((s) => s.addHTab);
  const setHTabCwd = useStore((s) => s.setHTabCwd);
  const closeHTabsWhere = useStore((s) => s.closeHTabsWhere);

  /**
   * Open a tab working in `dir` when there isn't one yet. The path goes through
   * the fs endpoint first so it takes the same normalized form a tab's cwd
   * carries (the tab bar's inline editor resolves paths the same way). Shared
   * by the branch chip and the open-after-create flow of the new-worktree
   * dialog — which also passes the task description for the new tab's terminal
   * (see queueWorktreeSetup). `activate: false` creates/queues everything but
   * leaves the user's current tab focused (the new-worktree dialog uses this:
   * create the tab, don't jump to it).
   */
  const openTabForDir = useCallback(
    async (dir: string, setupDescription?: string, opts?: { activate?: boolean }) => {
      const activate = opts?.activate !== false;
      let target = dir;
      try {
        const r = await fetch(apiPath(`/api/fs/list?path=${encodeURIComponent(target)}`));
        const data = r.ok ? ((await r.json()) as { path?: string }) : {};
        if (data.path) target = data.path;
      } catch {
        /* keep git's spelling of the path */
      }
      const hit = activeNode(useStore.getState())?.htabs.find((h) => h.cwd && sameDir(h.cwd, target));
      if (hit) {
        if (activate) setActiveHTab(hit.id);
        return;
      }
      // addHTab activates the tab it makes; claim it for the directory.
      const previous = activate ? undefined : activeNode(useStore.getState())?.activeHTab;
      addHTab();
      const created = activeNode(useStore.getState())?.activeHTab;
      if (created) {
        setHTabCwd(created, target);
        if (setupDescription !== undefined) {
          const leaf = activeNode(useStore.getState())?.htabs.find((h) => h.id === created)?.focused;
          // Queued before React mounts the pane's terminal, which consumes it
          // when the shell first spawns.
          if (leaf) {
            queueWorktreeSetup(leaf, setupDescription);
            // A background tab's terminal would otherwise only spawn on first
            // visit; prewarm so the setup script runs right away.
            if (!activate) prewarmSession(leaf, target);
          }
        }
        // Hand focus back so creating the tab didn't yank the user over to it.
        if (!activate && previous && previous !== created) setActiveHTab(previous);
      }
    },
    [setActiveHTab, addHTab, setHTabCwd],
  );

  /** The branch chip doubles as a "go to this worktree" button. */
  const openWorktreeTab = useCallback(async () => {
    if (overview?.repo !== true) return;
    await openTabForDir(overview.root);
  }, [overview, openTabForDir]);

  /**
   * What the address bar shows: the user's pick while one stands, else the
   * repo root in a repo (the panel's real scope — the tab's cwd may be a
   * subdirectory of it), else the directory the server resolved and found
   * repo-less.
   */
  const shownDir = cwd ?? (overview?.repo ? overview.root : overview?.cwd ?? "");

  // The address bar's own draft text — separate from `shownDir` so typing
  // doesn't fight the resolved value; synced back whenever not focused.
  const [dirDraft, setDirDraft] = useState(shownDir);
  const [dirFocused, setDirFocused] = useState(false);
  useEffect(() => {
    if (!dirFocused) setDirDraft(shownDir);
  }, [shownDir, dirFocused]);

  // Restore before paint so a remount (zen, drag to another tab) doesn't flash
  // at the top of the file before jumping back.
  useLayoutEffect(() => {
    const el = filesRef.current;
    const top = viewCache.get(viewId)?.scrollTop ?? 0;
    if (el && top) el.scrollTop = top;
  }, [viewId, overview]);

  const rows = overview && overview.repo ? overview.rows : [];

  // Which files open by default, spending a line budget down the list. Derived
  // in one pass rather than counted during render, so nothing depends on the
  // order React happens to render children in.
  const autoExpanded = useMemo(() => {
    const set = new Set<string>();
    let budget = AUTO_EXPAND_LINES;
    for (const row of rows) {
      const cost = row.additions + row.deletions;
      // Always open the first file, however big — landing on a wall of
      // collapsed headers with nothing shown reads as a broken panel.
      if (set.size > 0 && (budget < cost || set.size >= AUTO_EXPAND_FILES)) break;
      set.add(rowKey(row));
      budget -= cost;
    }
    return set;
  }, [rows]);

  // Collapse state is keyed by file so a manual toggle survives a refresh.
  const isExpanded = useCallback(
    (row: GitRow) => {
      const key = rowKey(row);
      return key in collapsed ? !collapsed[key] : autoExpanded.has(key);
    },
    [collapsed, autoExpanded],
  );

  const expandedRows = useMemo(() => rows.filter(isExpanded), [rows, isExpanded]);
  // Identity of the request, so expanding one more card refetches once rather
  // than on every render.
  const expandedKeys = expandedRows.map(rowKey).join("\n");

  // One request for every open file. Server-side this is two git invocations
  // per section regardless of file count, instead of one process per file.
  useEffect(() => {
    if (!expandedRows.length) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(apiPath("/api/git/diffs"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base: shownBase || undefined,
            cwd: cwd ?? tabCwd ?? undefined,
            worktree: overview?.repo ? overview.root : undefined,
            files: expandedRows.map((row) => ({
              path: row.path,
              oldPath: row.oldPath,
              section: row.section,
            })),
          }),
        });
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as { diffs: Record<string, DiffPayload> };
        // Merged, not replaced: a card collapsed since the request went out
        // keeps its body for when it is opened again.
        if (!cancelled) setDiffs((prev) => ({ ...prev, ...data.diffs }));
      } catch {
        /* leave the previous bodies up; the toolbar refresh is the retry */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, expandedKeys, tabCwd, shownBase, cwd]);

  const groups = useMemo(() => {
    const order: Section[] = ["changed", "staged", "unstaged", "untracked"];
    const labels: Record<Section, string> = {
      changed: t("gitdiff.changedVs", { base: shownBase }),
      staged: t("gitdiff.staged"),
      unstaged: t("gitdiff.unstaged"),
      untracked: t("gitdiff.untracked"),
    };
    return order
      .map((section) => ({ section, label: labels[section], rows: rows.filter((r) => r.section === section) }))
      .filter((g) => g.rows.length > 0);
  }, [rows, t, shownBase]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({ add: acc.add + r.additions, del: acc.del + r.deletions }),
        { add: 0, del: 0 },
      ),
    [rows],
  );

  const refOptions = useMemo(() => {
    const refs = overview && overview.repo ? overview.refs : [];
    return [
      { value: WORKING_TREE, label: t("gitdiff.workingTree") },
      // Every branch is offered as deletable; the server refuses the ones git
      // won't let go (checked out, remote-tracking) with a reason the dialog
      // shows.
      ...refs.map((r) => ({ value: r, label: r, removable: true })),
    ];
  }, [overview, t]);

  // The directory name is the identity here, not the branch: an agent's
  // worktree is announced by its directory ("wobbly-shimmying-rose"), and the
  // toolbar already names the selected one's branch. The count marks where an
  // agent has actually been working. The server omits the list for a plain
  // single-checkout repo, so that case synthesizes the lone main entry — the
  // switcher stays visible for its "New worktree…" action.
  const worktreeList = useMemo<GitWorktree[]>(() => {
    if (overview?.repo !== true) return [];
    return (
      overview.worktrees ?? [{ path: overview.root, name: "", branch: overview.branch, main: true, files: 0 }]
    );
  }, [overview]);

  const worktreeOptions = useMemo(
    () =>
      worktreeList.map((w) => ({
        value: w.path,
        label: (w.main ? t("gitdiff.mainWorktree") : w.name) + (w.files > 0 ? ` · ${w.files}` : ""),
        removable: !w.main,
      })),
    [worktreeList, t],
  );

  const [newOpen, setNewOpen] = useState(false);
  const [removing, setRemoving] = useState<GitWorktree | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);

  /**
   * What the dialog just created and wants a tab opened for: the worktree's
   * directory plus the setup steps to run in that tab's terminal. The open
   * happens when the dialog CLOSES, not mid-create: activating another tab
   * can unmount this panel (and the dialog with it).
   */
  const createdRef = useRef<{ dir: string; description: string } | null>(null);

  const createWorktree = useCallback(
    async (branch: string, baseRef: string, opts: { todo: string; openTab: boolean }): Promise<void> => {
      const r = await fetch(apiPath("/api/git/worktrees"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: cwd ?? tabCwd ?? undefined,
          branch,
          base: baseRef || undefined,
        }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string; path?: string };
      if (!r.ok) throw new Error(data.error ?? String(r.status));
      if (opts.openTab && data.path) {
        createdRef.current = { dir: data.path, description: opts.todo.trim() };
      }
      await load();
    },
    [tabCwd, cwd, load],
  );

  const closeNewDialog = useCallback(() => {
    setNewOpen(false);
    const created = createdRef.current;
    createdRef.current = null;
    // Create the new worktree's tab (and queue its setup) without jumping to it.
    if (created) void openTabForDir(created.dir, created.description, { activate: false });
  }, [openTabForDir]);

  const removeWorktreeByPath = useCallback(
    async (wt: GitWorktree, withBranch: boolean) => {
      // Tabs pointed at the doomed directory (or anywhere under it) close
      // first: their shells would hold the directory open — Windows refuses
      // the move-aside while one does — and they'd be left on a path that
      // no longer exists.
      closeHTabsWhere((tabDir) => inDir(wt.path, tabDir));
      const params = new URLSearchParams({ worktree: wt.path });
      const dir = cwd ?? tabCwd;
      if (dir) params.set("cwd", dir);
      if (withBranch) params.set("branch", "1");
      const r = await fetch(apiPath(`/api/git/worktrees?${params}`), { method: "DELETE" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? String(r.status));
      // Removing the worktree the panel is pointed at sends it back to the
      // main checkout; removing another one just refreshes the list.
      if (overview?.repo === true && overview.root === wt.path) {
        const main = worktreeList.find((w) => w.main);
        if (main) selectWorktree(main.path);
      }
      await load();
    },
    [tabCwd, cwd, overview, worktreeList, selectWorktree, load, closeHTabsWhere],
  );

  const deleteBranchByName = useCallback(
    async (name: string, force: boolean) => {
      const params = new URLSearchParams({ branch: name });
      const dir = cwd ?? tabCwd;
      if (dir) params.set("cwd", dir);
      if (force) params.set("force", "1");
      const r = await fetch(apiPath(`/api/git/branches?${params}`), { method: "DELETE" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const error = new Error(data.error ?? String(r.status)) as Error & { notMerged?: boolean };
        error.notMerged = data.notMerged === true;
        throw error;
      }
      // Deleting the branch the compare is measured against hands the pick
      // back to the server's choice; anything else just refreshes the list.
      if (name === shownBase) setBase(null);
      await load();
    },
    [tabCwd, cwd, shownBase, load],
  );

  return (
    <div className={`gd-root gd-${variant}`}>
      <div className="gd-toolbar">
        {overview?.repo === true && variant === "pane" ? (
          // In a pane the chip is also a jump button; in the modal it stays a
          // plain label — the overlay would hide the tab switch it triggers.
          <button
            className="gd-branch gd-branch-jump"
            title={t("gitdiff.openWorktreeTab", { dir: overview.root })}
            onClick={() => void openWorktreeTab()}
          >
            <GitBranchIcon />
            <span>{overview.branch}</span>
          </button>
        ) : (
          <span className="gd-branch">
            <GitBranchIcon />
            <span>{overview && overview.repo ? overview.branch : t("gitdiff.title")}</span>
          </span>
        )}
        {/* The directory the panel reads from, editable so a wrong guess (the
            tab's cwd by default) can be corrected in place. Empty + Enter
            hands it back to the tab's cwd. */}
        <input
          className="gd-dir"
          {...ime.props}
          value={dirDraft}
          spellCheck={false}
          title={shownDir}
          aria-label={t("gitdiff.workingDir")}
          placeholder={t("gitdiff.workingDir")}
          onFocus={() => setDirFocused(true)}
          onChange={(e) => setDirDraft(e.target.value)}
          onBlur={() => {
            setDirFocused(false);
            setDirDraft(shownDir);
          }}
          onKeyDown={(e) => {
            if (ime.handled(e)) return;
            if (e.key === "Enter") {
              const target = dirDraft.trim();
              if (target !== shownDir) selectCwd(target || null);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setDirDraft(shownDir);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {overview && overview.repo && (
          <>
            {worktreeOptions.length > 0 && (
              <UsageSelect
                value={overview.root}
                options={worktreeOptions}
                onChange={selectWorktree}
                width={170}
                actions={[{ label: t("gitdiff.newWorktree"), onSelect: () => setNewOpen(true) }]}
                onRemove={(path) => {
                  const wt = worktreeList.find((w) => w.path === path);
                  if (wt) setRemoving(wt);
                }}
              />
            )}
            {/* A fixed marker rather than a per-option "Compare with X" prefix:
                the target's name is the only thing that varies, so it is the
                only thing the control shows. */}
            <span className="gd-vs" title={t("gitdiff.compareWith")}>
              <GitCompareIcon />
            </span>
            <UsageSelect
              value={shownBase}
              options={refOptions}
              onChange={setBase}
              width={180}
              onRemove={setDeletingBranch}
            />
            {rows.length > 0 && (
              <span className="gd-summary">
                {t("gitdiff.summary", { files: rows.length })}
                <em className="add">+{totals.add}</em>
                <em className="del">−{totals.del}</em>
              </span>
            )}
            <button className="gd-refresh" title={t("gitdiff.refresh")} onClick={load}>
              <RefreshIcon />
            </button>
          </>
        )}
      </div>

      {overview === undefined && <div className="gd-empty">{t("gitdiff.loading")}</div>}
      {overview === null && <div className="gd-empty">{t("gitdiff.error")}</div>}
      {overview?.repo === false && <div className="gd-empty">{t("gitdiff.noRepo")}</div>}
      {overview?.repo === true && rows.length === 0 && (
        <div className="gd-empty">
          {shownBase ? t("gitdiff.sameAs", { base: shownBase }) : t("gitdiff.clean")}
        </div>
      )}

      {overview?.repo === true && rows.length > 0 && (
        <div
          className="gd-files"
          ref={filesRef}
          onScroll={(e) => remember(viewId, { scrollTop: e.currentTarget.scrollTop })}
        >
          {groups.map((group) => (
            <div key={group.section} className="gd-group">
              <div className="gd-group-head">
                <span>{group.label}</span>
                <span>{group.rows.length}</span>
              </div>
              {group.rows.map((row) => {
                const key = rowKey(row);
                const expanded = isExpanded(row);
                return (
                  <FileCard
                    key={key}
                    row={row}
                    diff={diffs[key]}
                    expanded={expanded}
                    onToggle={() => setCollapsed((c) => ({ ...c, [key]: expanded }))}
                  />
                );
              })}
            </div>
          ))}
          {overview.overflow && <div className="gd-note">{t("gitdiff.overflow")}</div>}
        </div>
      )}

      {newOpen && overview?.repo === true && (
        <NewWorktreeDialog
          refs={overview.refs}
          defaultBase={worktreeList.find((w) => w.main)?.branch ?? overview.branch}
          onCreate={createWorktree}
          onClose={closeNewDialog}
        />
      )}
      {removing && (
        <RemoveWorktreeDialog
          worktree={removing}
          onRemove={removeWorktreeByPath}
          onClose={() => setRemoving(null)}
        />
      )}
      {deletingBranch && (
        <DeleteBranchDialog
          branch={deletingBranch}
          onDelete={deleteBranchByName}
          onClose={() => setDeletingBranch(null)}
        />
      )}
    </div>
  );
}
