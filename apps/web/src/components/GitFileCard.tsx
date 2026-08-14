import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { CheckIcon, ChevronIcon, CopyIcon } from "./icons";

export type Section = "staged" | "unstaged" | "untracked" | "changed";

export interface GitRow {
  path: string;
  oldPath?: string;
  section: Section;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  isDir?: boolean;
}

export interface DiffPayload {
  diff: string;
  binary?: boolean;
  truncated?: boolean;
}

/**
 * How much diff to open on arrival. Budgeting by LINES rather than by file
 * count is what keeps a compare of fifteen 4000-line files from laying down a
 * quarter-million DOM nodes before you have scrolled anywhere. The file cap
 * backs it up for untracked entries, whose size isn't known until fetched.
 */
export const AUTO_EXPAND_LINES = 3000;
export const AUTO_EXPAND_FILES = 50;

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

/** Key a diff by the same identity the server groups rows under. */
export const rowKey = (r: GitRow) => `${r.section}:${r.path}`;

/**
 * One file's card. The diff is handed down rather than fetched here: the
 * parent asks for every expanded file in a single request, so a refresh
 * refreshes the bodies too (a per-card fetch keyed on the path would keep
 * showing the old diff after the file changed underneath it).
 */
export function FileCard({
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
