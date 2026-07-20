import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
// A single file's diff bigger than this is useless to read and expensive to
// ship, so the viewer shows the head of it and says it was cut.
const DIFF_CAP = 512 * 1024;
// Guard against a compare that touches the whole tree (a rename of the repo
// root, a reformat commit). The viewer reports the overflow rather than
// silently showing a partial list.
const MAX_ROWS = 500;

/**
 * Which side of the index a row came from. "changed" is the base-comparison
 * mode (merge-base -> working tree), where staged/unstaged is not a meaningful
 * distinction — everything is simply "different from that branch".
 */
export type Section = "staged" | "unstaged" | "untracked" | "changed";

export type GitRow = {
  /** Repo-root-relative path. */
  path: string;
  /** Previous path, present only for renames/copies. */
  oldPath?: string;
  section: Section;
  /** Single status letter: M, A, D, R, C, or "?" for untracked. */
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  /** True when the entry is an untracked *directory* (porcelain reports "dir/"). */
  isDir?: boolean;
};

export type GitOverview =
  | { repo: false }
  | {
      repo: true;
      root: string;
      branch: string;
      /** Echoed back so the client knows which compare produced these rows. */
      base?: string;
      /** Branch names offered in the compare picker. */
      refs: string[];
      rows: GitRow[];
      /** Set when the row list hit MAX_ROWS and was cut. */
      overflow?: boolean;
    };

export type GitDiff = {
  diff: string;
  binary?: boolean;
  truncated?: boolean;
};

async function git(args: string[], cwd: string): Promise<string> {
  // core.quotepath=false keeps non-ASCII paths readable in diff headers
  // instead of octal-escaped (\344\270\255).
  const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

/** The repo root containing `cwd`, or null when `cwd` is not inside a work tree. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(["rev-parse", "--show-toplevel"], cwd);
    const root = out.trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

async function currentBranch(root: string): Promise<string> {
  // symbolic-ref works on a repo with no commits yet, where rev-parse HEAD
  // would fail outright.
  try {
    const out = await git(["symbolic-ref", "--short", "HEAD"], root);
    if (out.trim()) return out.trim();
  } catch {
    /* detached HEAD — fall through to the short sha */
  }
  try {
    const out = await git(["rev-parse", "--short", "HEAD"], root);
    if (out.trim()) return out.trim();
  } catch {
    /* a repo with no commits yet; leave it unnamed rather than fail the panel */
  }
  return "HEAD";
}

/** Branch names for the compare picker, most recently committed first. */
async function listRefs(root: string): Promise<string[]> {
  try {
    const out = await git(
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
      ],
      root,
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.endsWith("/HEAD"))
      .slice(0, 200);
  } catch {
    return [];
  }
}

/**
 * `git diff --numstat -z` emits "adds\tdels\tpath\0", except for renames where
 * the path field is empty and the two following NUL-separated tokens carry the
 * old and new paths. Binary files report "-" for both counts.
 */
function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const parts = token.split("\t");
    if (parts.length < 3) continue;
    const [adds, dels] = parts;
    let filePath = parts[2];
    if (!filePath) {
      i++; // old path — the new path is what the row is keyed by
      filePath = tokens[++i] ?? "";
    }
    if (!filePath) continue;
    counts.set(filePath, {
      additions: adds === "-" ? 0 : Number(adds) || 0,
      deletions: dels === "-" ? 0 : Number(dels) || 0,
      binary: adds === "-" && dels === "-",
    });
  }
  return counts;
}

/**
 * `git diff --name-status -z` emits "STATUS\0path\0", except for renames and
 * copies ("R100", "C75") where two paths follow.
 */
function parseNameStatus(out: string): { path: string; oldPath?: string; status: string }[] {
  const rows: { path: string; oldPath?: string; status: string }[] = [];
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!status) continue;
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      if (newPath) rows.push({ path: newPath, oldPath, status: letter });
    } else {
      const filePath = tokens[++i];
      if (filePath) rows.push({ path: filePath, status: letter });
    }
  }
  return rows;
}

/** Changed tracked files for one diff invocation, with their line counts. */
async function diffRows(root: string, args: string[], section: Section): Promise<GitRow[]> {
  const [nameStatus, numstat] = await Promise.all([
    git(["diff", "--name-status", "-z", ...args], root),
    git(["diff", "--numstat", "-z", ...args], root),
  ]);
  const counts = parseNumstat(numstat);
  return parseNameStatus(nameStatus).map((r) => {
    const c = counts.get(r.path);
    return {
      ...r,
      section,
      additions: c?.additions ?? 0,
      deletions: c?.deletions ?? 0,
      ...(c?.binary ? { binary: true } : {}),
    };
  });
}

/** Untracked entries, which no `git diff` reports — they come from status. */
async function untrackedRows(root: string): Promise<GitRow[]> {
  const out = await git(["status", "--porcelain=v1", "-z"], root);
  const rows: GitRow[] = [];
  for (const record of out.split("\0")) {
    if (record.length < 4 || record[0] !== "?") continue;
    let filePath = record.slice(3);
    const isDir = filePath.endsWith("/");
    if (isDir) filePath = filePath.slice(0, -1);
    rows.push({
      path: filePath,
      section: "untracked",
      status: "?",
      // Counting lines here would mean reading every new file just to render a
      // badge; the file's own diff fills these in once it's opened.
      additions: 0,
      deletions: 0,
      ...(isDir ? { isDir: true } : {}),
    });
  }
  return rows;
}

/**
 * The commit to diff against for a base comparison. Using the merge base
 * rather than the branch tip is what makes "vs main" mean "what this branch
 * changes" instead of also folding in everything main gained since it forked.
 */
async function mergeBase(root: string, base: string): Promise<string> {
  try {
    const out = await git(["merge-base", base, "HEAD"], root);
    if (out.trim()) return out.trim();
  } catch {
    /* unrelated histories, or HEAD has no commits — compare to the ref itself */
  }
  return base;
}

/** Reject a ref that could be read as an option or a pathspec escape. */
function validRef(ref: string): boolean {
  return /^[\w.\-/]+$/.test(ref) && !ref.startsWith("-") && !ref.includes("..");
}

export async function gitOverview(cwd: string, base?: string): Promise<GitOverview> {
  const root = await repoRoot(cwd);
  if (!root) return { repo: false };

  const [branch, refs] = await Promise.all([currentBranch(root), listRefs(root)]);
  const useBase = base && validRef(base) && refs.includes(base) ? base : undefined;

  let rows: GitRow[];
  if (useBase) {
    const against = await mergeBase(root, useBase);
    const [changed, untracked] = await Promise.all([
      diffRows(root, [against], "changed"),
      untrackedRows(root),
    ]);
    rows = [...changed, ...untracked];
  } else {
    const [staged, unstaged, untracked] = await Promise.all([
      diffRows(root, ["--cached"], "staged"),
      diffRows(root, [], "unstaged"),
      untrackedRows(root),
    ]);
    rows = [...staged, ...unstaged, ...untracked];
  }

  const overflow = rows.length > MAX_ROWS;
  return {
    repo: true,
    root,
    branch,
    ...(useBase ? { base: useBase } : {}),
    refs,
    rows: overflow ? rows.slice(0, MAX_ROWS) : rows,
    ...(overflow ? { overflow: true } : {}),
  };
}

/** Reject paths that escape the repo root (`../`, absolute, symlink-ish tricks). */
function insideRoot(root: string, relative: string): string | null {
  const abs = path.resolve(root, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/**
 * Both markers are whole lines git emits itself, so they are anchored: an
 * unanchored substring test reports "binary" for any text file whose own
 * contents mention the marker — including this one, which diffs as a binary
 * file the moment it is edited.
 */
function isBinaryDiff(diff: string): boolean {
  return /^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff);
}

function cap(diff: string): GitDiff {
  if (diff.length <= DIFF_CAP) return { diff };
  return { diff: diff.slice(0, DIFF_CAP), truncated: true };
}

/**
 * Synthesize an all-additions diff for an untracked file. `git diff --no-index
 * /dev/null <file>` would also work but exits non-zero on difference and needs
 * a platform-specific null device, so building the hunk here is both simpler
 * and portable.
 */
async function untrackedDiff(abs: string, relative: string): Promise<GitDiff> {
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(abs);
  } catch {
    return { diff: "" };
  }
  // Same heuristic as /api/fs/read: a NUL byte in the head means "not text".
  if (buf.subarray(0, 8000).includes(0)) return { diff: "", binary: true };
  const text = buf.toString("utf8");
  if (!text) return { diff: "" };
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  const tail = endsWithNewline ? "\n" : "\n\\ No newline at end of file\n";
  const header = `--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${lines.length} @@\n`;
  return cap(header + body + tail);
}

export async function gitDiff(opts: {
  cwd: string;
  path: string;
  oldPath?: string;
  section: Section;
  base?: string;
}): Promise<GitDiff & { repo: boolean }> {
  const root = await repoRoot(opts.cwd);
  if (!root) return { repo: false, diff: "" };
  const abs = insideRoot(root, opts.path);
  if (!abs) return { repo: true, diff: "" };

  if (opts.section === "untracked") {
    return { repo: true, ...(await untrackedDiff(abs, opts.path)) };
  }

  const args = ["diff", "--no-color"];
  if (opts.section === "staged") args.push("--cached");
  if (opts.section === "changed") {
    if (!opts.base || !validRef(opts.base)) return { repo: true, diff: "" };
    args.push(await mergeBase(root, opts.base));
  }
  args.push("--", opts.path);
  // Rename detection pairs the two sides only if both are in the pathspec;
  // with just the new path git reports the change as a whole new file.
  if (opts.oldPath && insideRoot(root, opts.oldPath)) args.push(opts.oldPath);
  const out = await git(args, root);
  if (isBinaryDiff(out)) return { repo: true, diff: "", binary: true };
  return { repo: true, ...cap(out) };
}
