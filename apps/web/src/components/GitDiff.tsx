import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import { GitBranchIcon, RefreshIcon } from "./icons";

interface GitFile {
  path: string;
  oldPath?: string;
  x: string;
  y: string;
  isDir?: boolean;
}

type GitStatus =
  | { repo: false }
  | { repo: true; root: string; branch: string; files: GitFile[] };

interface DiffPayload {
  repo: boolean;
  diff: string;
  binary?: boolean;
  truncated?: boolean;
}

/** Which side of the index a row shows — the three groups in the file list. */
type Section = "staged" | "unstaged" | "untracked";

interface Row {
  section: Section;
  file: GitFile;
  /** Status letter for this side: the index letter when staged, else worktree. */
  status: string;
}

/**
 * A file modified both in the index and the worktree is genuinely two different
 * diffs, so it gets a row in each group rather than one ambiguous row.
 */
function toRows(files: GitFile[]): Row[] {
  const rows: Row[] = [];
  for (const f of files) {
    if (f.x === "?") {
      rows.push({ section: "untracked", file: f, status: "?" });
      continue;
    }
    if (f.x !== " ") rows.push({ section: "staged", file: f, status: f.x });
    if (f.y !== " ") rows.push({ section: "unstaged", file: f, status: f.y });
  }
  return rows;
}

const rowKey = (r: Row) => `${r.section}:${r.file.path}`;

type LineKind = "add" | "del" | "meta" | "hunk" | "ctx";

/**
 * Classify unified-diff lines for rendering. The `diff --git` / `index` /
 * `--- +++` preamble is dropped: the header above already names the file, and
 * repeating it costs the reader four lines before every hunk.
 */
function parseDiff(diff: string): { kind: LineKind; text: string }[] {
  const out: { kind: LineKind; text: string }[] = [];
  for (const line of diff.split("\n")) {
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
    if (line.startsWith("@@")) out.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) out.push({ kind: "add", text: line });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line });
    else if (line.startsWith("\\")) out.push({ kind: "meta", text: line });
    else out.push({ kind: "ctx", text: line });
  }
  // A diff ends with a newline, so the split leaves a trailing blank.
  while (out.length && out[out.length - 1].kind === "ctx" && !out[out.length - 1].text) out.pop();
  return out;
}

/**
 * Working-tree diff viewer for the repo containing the focused pane's cwd
 * (the SideRail branch button / ⌘⌥G). Left column lists changed files grouped
 * by staged / unstaged / untracked; selecting one fetches that file's unified
 * diff — see /api/git/status and /api/git/diff.
 */
export function GitDiff({ session, onClose }: { session?: string; onClose: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null | undefined>(undefined);

  const rows = useMemo(
    () => (status && status.repo ? toRows(status.files) : []),
    [status],
  );

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch(apiPath(`/api/git/status?session=${encodeURIComponent(session ?? "")}`));
      if (!r.ok) throw new Error(String(r.status));
      setStatus((await r.json()) as GitStatus);
    } catch {
      setStatus(null);
    }
  }, [session]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Re-check on window focus: the whole point of the panel is reading what the
  // agent in the terminal just changed, and those changes land while it's open.
  useEffect(() => {
    window.addEventListener("focus", loadStatus);
    return () => window.removeEventListener("focus", loadStatus);
  }, [loadStatus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keep a selection pinned to a row that still exists — after a refresh the
  // previously selected file may have been staged or reverted away.
  useEffect(() => {
    if (!rows.length) {
      setSelected(null);
      return;
    }
    setSelected((cur) => (cur && rows.some((r) => rowKey(r) === cur) ? cur : rowKey(rows[0])));
  }, [rows]);

  const current = rows.find((r) => rowKey(r) === selected);

  useEffect(() => {
    if (!current) {
      setDiff(undefined);
      return;
    }
    if (current.file.isDir) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(undefined);
    const params = new URLSearchParams({
      session: session ?? "",
      path: current.file.path,
      staged: current.section === "staged" ? "1" : "0",
      untracked: current.section === "untracked" ? "1" : "0",
    });
    if (current.file.oldPath) params.set("oldPath", current.file.oldPath);
    (async () => {
      try {
        const r = await fetch(apiPath(`/api/git/diff?${params}`));
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as DiffPayload;
        if (!cancelled) setDiff(data);
      } catch {
        if (!cancelled) setDiff(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `current` is derived from rows+selected and would be a new object each
    // render; the identity that matters is which row is selected.
  }, [selected, session, current?.file.path, current?.file.isDir, current?.file.oldPath]);

  // ↑/↓ walk the file list without leaving the diff pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (!rows.length) return;
      e.preventDefault();
      const i = rows.findIndex((r) => rowKey(r) === selected);
      const next = (i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      setSelected(rowKey(rows[next]));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selected]);

  const lines = useMemo(() => (diff?.diff ? parseDiff(diff.diff) : []), [diff]);

  const sections: { key: Section; label: string }[] = [
    { key: "staged", label: t("gitdiff.staged") },
    { key: "unstaged", label: t("gitdiff.unstaged") },
    { key: "untracked", label: t("gitdiff.untracked") },
  ];

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="usage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="usage-header">
          <span className="usage-title">
            <GitBranchIcon />
            <span>{status && status.repo ? status.branch : t("gitdiff.title")}</span>
          </span>
          {status && status.repo && (
            <span className="gitdiff-meta">
              <span className="gitdiff-root" title={status.root}>
                {status.root}
              </span>
              <button
                className="gitdiff-refresh"
                title={t("gitdiff.refresh")}
                onClick={loadStatus}
              >
                <RefreshIcon />
              </button>
            </span>
          )}
        </div>

        {status === undefined && <div className="search-empty">{t("gitdiff.loading")}</div>}
        {status === null && <div className="search-empty">{t("gitdiff.error")}</div>}
        {status?.repo === false && <div className="search-empty">{t("gitdiff.noRepo")}</div>}
        {status?.repo === true && rows.length === 0 && (
          <div className="search-empty">{t("gitdiff.clean")}</div>
        )}

        {status?.repo === true && rows.length > 0 && (
          <div className="gitdiff-body">
            <div className="gitdiff-files">
              {sections.map(({ key, label }) => {
                const group = rows.filter((r) => r.section === key);
                if (!group.length) return null;
                return (
                  <div key={key} className="gitdiff-group">
                    <div className="gitdiff-group-head">
                      <span>{label}</span>
                      <span>{group.length}</span>
                    </div>
                    {group.map((row) => (
                      <button
                        key={rowKey(row)}
                        className={`gitdiff-file ${selected === rowKey(row) ? "active" : ""}`}
                        onClick={() => setSelected(rowKey(row))}
                        title={row.file.oldPath ? `${row.file.oldPath} → ${row.file.path}` : row.file.path}
                      >
                        <span className={`gitdiff-status s-${row.status.trim() || "m"}`}>
                          {row.status.trim() || "•"}
                        </span>
                        <span className="gitdiff-path">
                          <em>{row.file.path.replace(/[^/]+$/, "")}</em>
                          <b>{row.file.path.split("/").pop()}</b>
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>

            <div className="gitdiff-pane">
              {diff === undefined && <div className="search-empty">{t("gitdiff.loading")}</div>}
              {diff === null && (
                <div className="search-empty">
                  {current?.file.isDir ? t("gitdiff.directory") : t("gitdiff.error")}
                </div>
              )}
              {diff?.binary && <div className="search-empty">{t("gitdiff.binary")}</div>}
              {diff && !diff.binary && lines.length === 0 && (
                <div className="search-empty">{t("gitdiff.empty")}</div>
              )}
              {diff && !diff.binary && lines.length > 0 && (
                <>
                  <pre className="gitdiff-code">
                    {lines.map((line, i) => (
                      <div key={i} className={`gitdiff-line ${line.kind}`}>
                        {line.text || " "}
                      </div>
                    ))}
                  </pre>
                  {diff.truncated && (
                    <div className="gitdiff-truncated">{t("gitdiff.truncated")}</div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
