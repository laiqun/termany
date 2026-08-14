import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "../api";
import { sameDir } from "../fs";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { activeNode, useStore, type GitMode } from "../state/store";
import { GitBranchIcon, GitCompareIcon, RefreshIcon } from "./icons";
import {
  AUTO_EXPAND_FILES,
  AUTO_EXPAND_LINES,
  FileCard,
  rowKey,
  type DiffPayload,
  type GitRow,
  type Section,
} from "./GitFileCard";
import { GitHistory } from "./GitHistory";
import { UsageSelect } from "./Select";

interface GitWorktree {
  path: string;
  name: string;
  branch: string;
  detached?: boolean;
  main: boolean;
  /** Changed-files badge. Absent when the list came from the cheap scope
   *  endpoint (history mode), which doesn't pay for per-worktree badges. */
  files?: number;
}

/** The cheap scope endpoint's payload (/api/git/worktrees) — no diff rows. */
type WorktreeScope =
  | { repo: false }
  | {
      repo: true;
      root: string;
      branch: string;
      refs: string[];
      worktrees: GitWorktree[];
    };

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

interface CachedView {
  base: string | Auto;
  worktree: string | Auto;
  cwd: string | Auto;
  collapsed: Record<string, boolean>;
  diffs: Record<string, DiffPayload>;
  overview: Overview | null | undefined;
  /** History mode's all-branches toggle. */
  all: boolean;
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
    all: false,
    scrollTop: 0,
    ...prev,
    ...patch,
  });
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
  gitMode,
}: {
  /** The tab's fixed working directory — the explicit dir every request
   *  names, which the server gives priority over any session resolution. */
  tabCwd?: string;
  variant: "pane" | "modal";
  /** Stable identity for the cached view state — the leaf id for a pane. */
  viewId: string;
  /** The pane chrome's changes/history switch. The modal has no chrome, so
   *  it always shows the changes body regardless of the pane's pick. */
  gitMode?: GitMode;
}) {
  const { t } = useI18n();
  const ime = useImeGuard();
  const cached = viewCache.get(viewId);
  const history = variant === "pane" && gitMode === "history";
  const [overview, setOverview] = useState<Overview | null | undefined>(cached?.overview);
  const [base, setBase] = useState<string | Auto>(cached?.base ?? null);
  const [worktree, setWorktree] = useState<string | Auto>(cached?.worktree ?? null);
  // Directory the user typed into the address bar; null follows the tab's cwd.
  const [cwd, setCwd] = useState<string | Auto>(cached?.cwd ?? null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(cached?.collapsed ?? {});
  const [diffs, setDiffs] = useState<Record<string, DiffPayload>>(cached?.diffs ?? {});
  // History mode: span every ref instead of just the checked-out branch.
  const [all, setAll] = useState(cached?.all ?? false);
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
      // History mode needs only the repo's shape (branch, worktrees) for the
      // toolbar and the scope for its own requests — the overview's diff rows
      // and worktree badges are git spawns nobody is looking at.
      if (history) {
        const r = await fetch(apiPath(`/api/git/worktrees?${params}`));
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as WorktreeScope;
        setOverview(
          data.repo
            ? { repo: true, cwd: dir ?? "", root: data.root, branch: data.branch, refs: data.refs, rows: [], worktrees: data.worktrees }
            : { repo: false, cwd: dir ?? "" },
        );
      } else {
        const r = await fetch(apiPath(`/api/git/overview?${params}`));
        if (!r.ok) throw new Error(String(r.status));
        setOverview((await r.json()) as Overview);
      }
      setRevision((n) => n + 1);
    } catch {
      setOverview(null);
    }
  }, [tabCwd, base, worktree, cwd, history]);

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
    remember(viewId, { overview, base, worktree, cwd, collapsed, diffs, all });
  }, [viewId, overview, base, worktree, cwd, collapsed, diffs, all]);

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

  /**
   * Open a tab working in `dir` when there isn't one yet. The path goes through
   * the fs endpoint first so it takes the same normalized form a tab's cwd
   * carries (the tab bar's inline editor resolves paths the same way). Used by
   * the branch chip, which doubles as a "go to this worktree" button.
   */
  const openTabForDir = useCallback(
    async (dir: string) => {
      let target = dir;
      try {
        const r = await fetch(apiPath(`/api/fs/list?path=${encodeURIComponent(target)}`));
        const data = r.ok ? ((await r.json()) as { path?: string }) : {};
        if (data.path) target = data.path;
      } catch {
        /* keep git's spelling of the path */
      }
      const hit = activeNode(useStore.getState())?.htabs.find((h) => h.cwd && sameDir(h.cwd, target));
      // addHTab activates the tab it makes, so the else branch lands on it.
      if (hit) setActiveHTab(hit.id);
      else addHTab(target);
    },
    [setActiveHTab, addHTab],
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
    return [{ value: WORKING_TREE, label: t("gitdiff.workingTree") }, ...refs.map((r) => ({ value: r, label: r }))];
  }, [overview, t]);

  // The directory name is the identity here, not the branch: an agent's
  // worktree is announced by its directory ("wobbly-shimmying-rose"), and the
  // toolbar already names the selected one's branch. The count marks where an
  // agent has actually been working. The server omits the list for a plain
  // single-checkout repo — no switcher is shown then, there is nothing to
  // switch between.
  const worktreeOptions = useMemo(
    () =>
      (overview?.repo === true ? (overview.worktrees ?? []) : []).map((w) => ({
        value: w.path,
        label: (w.main ? t("gitdiff.mainWorktree") : w.name) + ((w.files ?? 0) > 0 ? ` · ${w.files}` : ""),
      })),
    [overview, t],
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
              />
            )}
            {/* A fixed marker rather than a per-option "Compare with X" prefix:
                the target's name is the only thing that varies, so it is the
                only thing the control shows. */}
            {!history && (
              <>
                <span className="gd-vs" title={t("gitdiff.compareWith")}>
                  <GitCompareIcon />
                </span>
                <UsageSelect value={shownBase} options={refOptions} onChange={setBase} width={180} />
              </>
            )}
            {/* History mode's scope filter sits in the compare picker's slot:
                one scope control per mode, the row's density never changes. */}
            {history && (
              <UsageSelect
                value={all ? "all" : "branch"}
                options={[
                  { value: "branch", label: t("githistory.currentBranch") },
                  { value: "all", label: t("githistory.allBranches") },
                ]}
                onChange={(v) => setAll(v === "all")}
                width={150}
              />
            )}
            {!history && rows.length > 0 && (
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
      {!history && overview?.repo === true && rows.length === 0 && (
        <div className="gd-empty">
          {shownBase ? t("gitdiff.sameAs", { base: shownBase }) : t("gitdiff.clean")}
        </div>
      )}

      {history && overview?.repo === true && (
        <GitHistory
          cwd={cwd ?? tabCwd}
          worktree={overview.root}
          all={all}
          revision={revision}
          viewId={viewId}
        />
      )}

      {!history && overview?.repo === true && rows.length > 0 && (
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
    </div>
  );
}
