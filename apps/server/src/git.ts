import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
// A diff bigger than this is useless to read and expensive to ship/render, so
// the viewer shows the head of it and says it was cut.
const DIFF_CAP = 1024 * 1024;

export type GitFile = {
  /** Repo-root-relative path. */
  path: string;
  /** Previous path, present only for renames/copies. */
  oldPath?: string;
  /** Index (staged) status letter from porcelain v1; " " when unmodified. */
  x: string;
  /** Worktree (unstaged) status letter; " " when unmodified. */
  y: string;
  /** True when the entry is an untracked *directory* (porcelain reports "dir/"). */
  isDir?: boolean;
};

export type GitStatus =
  | { repo: false }
  | { repo: true; root: string; branch: string; files: GitFile[] };

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
    /* unreachable in practice; leave it unnamed rather than fail the panel */
  }
  return "HEAD";
}

/**
 * Parse `git status --porcelain=v1 -z`. NUL-delimited records avoid the
 * path-quoting escapes the newline format applies to spaces and non-ASCII,
 * so entries come back verbatim. A rename/copy record is followed by a
 * second record holding the source path.
 */
function parsePorcelain(out: string): GitFile[] {
  const records = out.split("\0");
  const files: GitFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    let filePath = record.slice(3);
    let oldPath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      oldPath = records[++i] ?? undefined;
    }
    const isDir = filePath.endsWith("/");
    if (isDir) filePath = filePath.slice(0, -1);
    files.push({ path: filePath, ...(oldPath ? { oldPath } : {}), x, y, ...(isDir ? { isDir: true } : {}) });
  }
  return files;
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const root = await repoRoot(cwd);
  if (!root) return { repo: false };
  const [branch, out] = await Promise.all([
    currentBranch(root),
    git(["status", "--porcelain=v1", "-z"], root),
  ]);
  const files = parsePorcelain(out);
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  return { repo: true, root, branch, files };
}

/** Reject paths that escape the repo root (`../`, absolute, symlink-ish tricks). */
function insideRoot(root: string, relative: string): string | null {
  const abs = path.resolve(root, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function isBinaryDiff(diff: string): boolean {
  return /^Binary files .* differ$/m.test(diff) || diff.includes("GIT binary patch");
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
  staged: boolean;
  untracked: boolean;
}): Promise<GitDiff & { repo: boolean }> {
  const root = await repoRoot(opts.cwd);
  if (!root) return { repo: false, diff: "" };
  const abs = insideRoot(root, opts.path);
  if (!abs) return { repo: true, diff: "" };

  if (opts.untracked) return { repo: true, ...(await untrackedDiff(abs, opts.path)) };

  const args = ["diff", "--no-color"];
  if (opts.staged) args.push("--cached");
  args.push("--", opts.path);
  // Rename detection pairs the two sides only if both are in the pathspec;
  // with just the new path git reports the change as a whole new file.
  if (opts.oldPath && insideRoot(root, opts.oldPath)) args.push(opts.oldPath);
  const out = await git(args, root);
  if (isBinaryDiff(out)) return { repo: true, diff: "", binary: true };
  return { repo: true, ...cap(out) };
}
