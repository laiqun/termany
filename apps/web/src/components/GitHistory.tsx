import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import {
  AUTO_EXPAND_FILES,
  AUTO_EXPAND_LINES,
  FileCard,
  rowKey,
  type DiffPayload,
  type GitRow,
} from "./GitFileCard";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "./icons";

type Translate = ReturnType<typeof useI18n>["t"];

interface GitCommit {
  sha: string;
  short: string;
  author: string;
  /** Committer date, epoch seconds. */
  date: number;
  subject: string;
  refs: string;
}

interface CommitDetail {
  rows: GitRow[];
  overflow?: boolean;
  diffs: Record<string, DiffPayload>;
}

/** Same formatter the session-history browser stamps its rows with. */
function relativeTime(mtimeMs: number, t: Translate): string {
  const mins = Math.floor((Date.now() - mtimeMs) / 60000);
  if (mins < 1) return t("history.time.now");
  if (mins < 60) return t("history.time.m", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("history.time.h", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("history.time.d", { n: days });
  return new Date(mtimeMs).toLocaleDateString();
}

interface CachedHistory {
  commits: GitCommit[];
  hasMore: boolean;
  selected: string | null;
  detail: CommitDetail | null;
  collapsed: Record<string, boolean>;
  listTop: number;
  detailTop: number;
}

/**
 * Survives the same remount churn as the changes view's cache (zen mode,
 * dragging the pane to another tab) — see viewCache in GitDiffView.
 */
const historyCache = new Map<string, CachedHistory>();
const MAX_CACHED_HISTORY = 8;

function remember(viewId: string, patch: Partial<CachedHistory>) {
  const prev = historyCache.get(viewId);
  if (!prev && historyCache.size >= MAX_CACHED_HISTORY) {
    historyCache.delete(historyCache.keys().next().value as string);
  }
  historyCache.set(viewId, {
    commits: [],
    hasMore: false,
    selected: null,
    detail: null,
    collapsed: {},
    listTop: 0,
    detailTop: 0,
    ...prev,
    ...patch,
  });
}

/**
 * The git pane's history body: the commit log on the left, the selected
 * commit's files on the right — the same cards the changes view renders, fed
 * by one request per commit rather than per expanded file. The toolbar above
 * (scope, branch filter, refresh) is the changes view's own; this component
 * only reads its picks.
 */
export function GitHistory({
  cwd,
  worktree,
  all,
  revision,
  viewId,
}: {
  /** Directory the panel reads from (the address bar's pick or the tab's). */
  cwd?: string;
  /** Resolved worktree root — the panel may be following a sibling worktree. */
  worktree?: string;
  /** Span every ref instead of just the checked-out branch. */
  all: boolean;
  /** Bumped by the toolbar's refresh (and every focus reload) — refetch. */
  revision: number;
  viewId: string;
}) {
  const { t } = useI18n();
  const cached = historyCache.get(viewId);
  const [commits, setCommits] = useState<GitCommit[]>(cached?.commits ?? []);
  const [hasMore, setHasMore] = useState(cached?.hasMore ?? false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState(false);
  const [selected, setSelected] = useState<string | null>(cached?.selected ?? null);
  const [detail, setDetail] = useState<CommitDetail | null>(cached?.detail ?? null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(cached?.collapsed ?? {});
  // Hides the commit list so the diff gets the full width — same idea as the
  // file preview's tree toggle. Not cached: a remount brings the list back.
  const [listCollapsed, setListCollapsed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (cwd) p.set("cwd", cwd);
    if (worktree) p.set("worktree", worktree);
    return p.toString();
  }, [cwd, worktree]);

  const loadPage = useCallback(
    async (skip: number, replace: boolean) => {
      setLoading(true);
      try {
        const p = new URLSearchParams(params);
        p.set("skip", String(skip));
        if (all) p.set("all", "1");
        const r = await fetch(apiPath(`/api/git/log?${p}`));
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as
          | { repo: false }
          | { repo: true; commits: GitCommit[]; hasMore: boolean };
        if (!data.repo) throw new Error("not a repo");
        setCommits((prev) => (replace ? data.commits : [...prev, ...data.commits]));
        setHasMore(data.hasMore);
        setListError(false);
      } catch {
        setListError(true);
      } finally {
        setLoading(false);
      }
    },
    [params, all],
  );

  // A new scope (directory, worktree, branch filter) starts the list over and
  // drops the selection — the commit that was open may not be in it. A plain
  // remount keeps the cached selection and quietly refreshes around it.
  const scopeKey = `${params}|${all}`;
  const prevScope = useRef(scopeKey);
  useEffect(() => {
    if (prevScope.current !== scopeKey) {
      prevScope.current = scopeKey;
      setSelected(null);
      setDetail(null);
      setCollapsed({});
    }
    void loadPage(0, true);
  }, [scopeKey, loadPage]);

  // The toolbar's refresh (and the focus reload) bumps the revision; the list
  // refetches, the selection stays — a commit's own content can't move.
  const mountedRevision = useRef(revision);
  useEffect(() => {
    if (revision === mountedRevision.current) return;
    mountedRevision.current = revision;
    void loadPage(0, true);
  }, [revision, loadPage]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      try {
        const p = new URLSearchParams(params);
        p.set("sha", selected);
        const r = await fetch(apiPath(`/api/git/commit?${p}`));
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as ({ repo: true } & CommitDetail) | { repo: false };
        if (!data.repo) throw new Error("not a repo");
        if (cancelled) return;
        setDetail({ rows: data.rows, overflow: data.overflow, diffs: data.diffs });
        setCollapsed({});
        if (detailRef.current) detailRef.current.scrollTop = 0;
      } catch {
        if (!cancelled) setDetail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, params]);

  useEffect(() => {
    remember(viewId, { commits, hasMore, selected, detail, collapsed });
  }, [viewId, commits, hasMore, selected, detail, collapsed]);

  // Restore scroll before paint so a remount doesn't flash at the top — the
  // changes view does the same for its file list.
  useEffect(() => {
    const c = historyCache.get(viewId);
    if (listRef.current && c?.listTop) listRef.current.scrollTop = c.listTop;
    // detailTop intentionally not restored: a fresh selection starts at the top.
  }, [viewId]);

  const rows = useMemo(() => detail?.rows ?? [], [detail]);

  // Same budget as the changes view: open files down the list until the line
  // budget runs out, but always open the first one.
  const autoExpanded = useMemo(() => {
    const set = new Set<string>();
    let budget = AUTO_EXPAND_LINES;
    for (const row of rows) {
      const cost = row.additions + row.deletions;
      if (set.size > 0 && (budget < cost || set.size >= AUTO_EXPAND_FILES)) break;
      set.add(rowKey(row));
      budget -= cost;
    }
    return set;
  }, [rows]);

  const selectedCommit = commits.find((c) => c.sha === selected);

  return (
    <div className={`gh-root ${listCollapsed ? "list-collapsed" : ""}`}>
      <div
        className="gh-list"
        ref={listRef}
        onScroll={(e) => remember(viewId, { listTop: e.currentTarget.scrollTop })}
      >
        {commits.map((c) => (
          <button
            key={c.sha}
            className={`gh-commit ${selected === c.sha ? "on" : ""}`}
            onClick={() => setSelected(c.sha)}
          >
            <span className="gh-line1">
              <span className="gh-sha">{c.short}</span>
              <span className="gh-subject">{c.subject}</span>
            </span>
            <span className="gh-line2">
              <span className="gh-author">{c.author}</span>
              <span className="gh-date">{relativeTime(c.date * 1000, t)}</span>
            </span>
            {c.refs && (
              <span className="gh-refs">
                {c.refs.split(", ").map((ref) => (
                  <span key={ref} className="gh-ref">
                    {ref.replace(/^HEAD -> /, "")}
                  </span>
                ))}
              </span>
            )}
          </button>
        ))}
        {loading && <div className="gd-note">{t("githistory.loading")}</div>}
        {!loading && listError && <div className="gd-note">{t("githistory.error")}</div>}
        {!loading && !listError && commits.length === 0 && (
          <div className="gd-empty">{t("githistory.empty")}</div>
        )}
        {!loading && hasMore && (
          <button className="gh-more" onClick={() => void loadPage(commits.length, false)}>
            {t("githistory.loadMore")}
          </button>
        )}
      </div>

      <div
        className="gh-detail"
        ref={detailRef}
        onScroll={(e) => remember(viewId, { detailTop: e.currentTarget.scrollTop })}
      >
        {/* The head always renders so the list toggle stays reachable when the
            list is collapsed — even with no commit selected. */}
        <div className="gh-detail-head">
          <button
            className="pane-btn gh-list-toggle"
            title={listCollapsed ? t("githistory.expandList") : t("githistory.collapseList")}
            aria-label={listCollapsed ? t("githistory.expandList") : t("githistory.collapseList")}
            onClick={() => setListCollapsed((v) => !v)}
          >
            {listCollapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
          </button>
          {selected && (
            <div className="gh-detail-headtext">
              <span className="gh-detail-subject">{selectedCommit?.subject ?? selected.slice(0, 7)}</span>
              {selectedCommit && (
                <span className="gh-detail-meta">
                  {selectedCommit.author} · {relativeTime(selectedCommit.date * 1000, t)} ·{" "}
                  {selectedCommit.short}
                </span>
              )}
            </div>
          )}
        </div>
        {!selected && <div className="gd-empty">{t("githistory.pick")}</div>}
        {selected && (
          <>
            {!detail && <div className="gd-note">{t("gitdiff.loading")}</div>}
            {detail && rows.length === 0 && <div className="gd-empty">{t("githistory.noFiles")}</div>}
            {detail &&
              rows.map((row) => {
                const key = rowKey(row);
                const expanded = key in collapsed ? !collapsed[key] : autoExpanded.has(key);
                return (
                  <FileCard
                    key={key}
                    row={row}
                    diff={detail.diffs[key]}
                    expanded={expanded}
                    onToggle={() => setCollapsed((c) => ({ ...c, [key]: expanded }))}
                  />
                );
              })}
            {detail?.overflow && <div className="gd-note">{t("gitdiff.overflow")}</div>}
          </>
        )}
      </div>
    </div>
  );
}
