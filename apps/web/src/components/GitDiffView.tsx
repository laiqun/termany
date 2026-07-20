import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import { ChevronIcon, GitBranchIcon, RefreshIcon } from "./icons";
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

type Overview =
  | { repo: false }
  | {
      repo: true;
      root: string;
      branch: string;
      base?: string;
      refs: string[];
      rows: GitRow[];
      overflow?: boolean;
    };

interface DiffPayload {
  diff: string;
  binary?: boolean;
  truncated?: boolean;
}

/** Sentinel for "no base ref" in the compare picker, which needs a string. */
const WORKING_TREE = "";

/**
 * Cards past this many start collapsed. Each expanded card fetches its own
 * diff, and each fetch spawns a git process — auto-expanding a 300-file
 * compare would stampede the server for output nobody has scrolled to yet.
 */
const AUTO_EXPAND_LIMIT = 15;

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

/** One file's card: header with counts, body with the diff, fetched on expand. */
function FileCard({
  row,
  session,
  base,
  expanded,
  onToggle,
}: {
  row: GitRow;
  session: string;
  base: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const [diff, setDiff] = useState<DiffPayload | null | undefined>(undefined);

  const skip = row.binary || row.isDir;

  useEffect(() => {
    if (!expanded || skip) return;
    let cancelled = false;
    setDiff(undefined);
    const params = new URLSearchParams({ session, path: row.path, section: row.section });
    if (row.oldPath) params.set("oldPath", row.oldPath);
    if (base) params.set("base", base);
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
  }, [expanded, skip, session, base, row.path, row.section, row.oldPath]);

  const lines = useMemo(() => (diff?.diff ? parseDiff(diff.diff) : []), [diff]);
  const dir = row.path.replace(/[^/]+$/, "");
  const name = row.path.split("/").pop();

  return (
    <div className="gd-card">
      <button className="gd-card-head" onClick={onToggle} aria-expanded={expanded}>
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

      {expanded && (
        <div className="gd-card-body">
          {row.isDir && <div className="gd-note">{t("gitdiff.directory")}</div>}
          {row.binary && <div className="gd-note">{t("gitdiff.binary")}</div>}
          {!skip && diff === undefined && <div className="gd-note">{t("gitdiff.loading")}</div>}
          {!skip && diff === null && <div className="gd-note">{t("gitdiff.error")}</div>}
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
 * Git diff viewer for the repo containing `session`'s cwd. Renders as a pane
 * view (the SideRail branch button) or inside the ⌘⌥G modal — same body, the
 * variant only changes the frame. Files are listed GitHub-style: one expandable
 * card each, with its unified diff and old/new line gutters inline.
 *
 * The compare picker switches between the working tree (staged / unstaged /
 * untracked, the default) and "what this branch changes vs <branch>", measured
 * from the merge base — see /api/git/overview.
 */
export function GitDiffView({ session, variant }: { session: string; variant: "pane" | "modal" }) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<Overview | null | undefined>(undefined);
  const [base, setBase] = useState(WORKING_TREE);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ session });
      if (base) params.set("base", base);
      const r = await fetch(apiPath(`/api/git/overview?${params}`));
      if (!r.ok) throw new Error(String(r.status));
      setOverview((await r.json()) as Overview);
    } catch {
      setOverview(null);
    }
  }, [session, base]);

  useEffect(() => {
    load();
  }, [load]);

  // Re-check on window focus: the point of the panel is reading what the agent
  // in the terminal just changed, and those changes land while it's open.
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const rows = overview && overview.repo ? overview.rows : [];

  // Collapse state is keyed by file, so it survives a refresh; only the
  // position-based default changes when the row list does.
  const isExpanded = useCallback(
    (row: GitRow, index: number) => {
      const key = rowKey(row);
      return key in collapsed ? !collapsed[key] : index < AUTO_EXPAND_LIMIT;
    },
    [collapsed],
  );

  const groups = useMemo(() => {
    const order: Section[] = ["changed", "staged", "unstaged", "untracked"];
    const labels: Record<Section, string> = {
      changed: t("gitdiff.changedVs", { base }),
      staged: t("gitdiff.staged"),
      unstaged: t("gitdiff.unstaged"),
      untracked: t("gitdiff.untracked"),
    };
    return order
      .map((section) => ({ section, label: labels[section], rows: rows.filter((r) => r.section === section) }))
      .filter((g) => g.rows.length > 0);
  }, [rows, t, base]);

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
      ...refs.map((r) => ({ value: r, label: t("gitdiff.vsRef", { ref: r }) })),
    ];
  }, [overview, t]);

  let index = -1;

  return (
    <div className={`gd-root gd-${variant}`}>
      <div className="gd-toolbar">
        <span className="gd-branch">
          <GitBranchIcon />
          <span>{overview && overview.repo ? overview.branch : t("gitdiff.title")}</span>
        </span>
        {overview && overview.repo && (
          <>
            <UsageSelect value={base} options={refOptions} onChange={setBase} width={200} />
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
        <div className="gd-empty">{base ? t("gitdiff.sameAs", { base }) : t("gitdiff.clean")}</div>
      )}

      {overview?.repo === true && rows.length > 0 && (
        <div className="gd-files">
          {groups.map((group) => (
            <div key={group.section} className="gd-group">
              <div className="gd-group-head">
                <span>{group.label}</span>
                <span>{group.rows.length}</span>
              </div>
              {group.rows.map((row) => {
                index++;
                const key = rowKey(row);
                const expanded = isExpanded(row, index);
                return (
                  <FileCard
                    key={key}
                    row={row}
                    session={session}
                    base={base}
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
