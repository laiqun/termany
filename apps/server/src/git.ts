import { exec, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
// A single file's diff bigger than this is useless to read and expensive to
// ship, so the viewer shows the head of it and says it was cut.
const DIFF_CAP = 512 * 1024;
// Guard against a compare that touches the whole tree (a rename of the repo
// root, a reformat commit). The viewer reports the overflow rather than
// silently showing a partial list.
const MAX_ROWS = 500;
// Each worktree in the switcher costs three git invocations to badge, so the
// list is bounded rather than left to grow with however many an agent left
// lying around.
const MAX_WORKTREES = 12;

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

export type GitWorktree = {
  /** Absolute path of this worktree's root — the id the client switches by. */
  path: string;
  /** Directory name, which is what an agent-created worktree is recognized by. */
  name: string;
  branch: string;
  /** No branch is checked out here (detached HEAD) — there is nothing to
   * offer for deletion alongside the directory. */
  detached?: boolean;
  /** The repository's own checkout, as opposed to a linked worktree. */
  main: boolean;
  /** Files differing from this worktree's own default compare base. */
  files: number;
};

export type GitOverview =
  | {
      repo: false;
      /** The directory the panel resolved to — echoed for its address bar. */
      cwd: string;
    }
  | {
      repo: true;
      /** The directory the panel resolved to — echoed for its address bar. */
      cwd: string;
      root: string;
      branch: string;
      /** Echoed back so the client knows which compare produced these rows. */
      base?: string;
      /** Branch names offered in the compare picker. */
      refs: string[];
      rows: GitRow[];
      /** Set when the row list hit MAX_ROWS and was cut. */
      overflow?: boolean;
      /** Every worktree of this repo, for the switcher. Omitted when there is
       * only the one — there is nothing to switch between. */
      worktrees?: GitWorktree[];
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
 * Every worktree attached to the repo, main one first — that is the order
 * `git worktree list` guarantees. Bare repos have no files to diff, so a bare
 * entry is dropped rather than offered as a destination.
 */
async function listWorktrees(root: string): Promise<Omit<GitWorktree, "files">[]> {
  try {
    const out = await git(["worktree", "list", "--porcelain"], root);
    const list: Omit<GitWorktree, "files">[] = [];
    for (const block of out.split("\n\n")) {
      const lines = block.split("\n").map((l) => l.trim());
      const dir = lines.find((l) => l.startsWith("worktree "))?.slice(9);
      if (!dir || lines.includes("bare")) continue;
      // A renamed or deleted worktree stays registered until `git worktree
      // prune` (marked "prunable"). Pointing the panel at the ghost path makes
      // every git spawn fail — Windows reports the missing cwd as "spawn git
      // ENOENT" — so the entry is dropped rather than offered as a target.
      if (!fs.existsSync(dir)) continue;
      const branch = lines.find((l) => l.startsWith("branch "))?.slice(7) ?? "";
      const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? "";
      list.push({
        path: path.resolve(dir),
        name: path.basename(dir),
        // A detached worktree has no branch line; its short sha names it.
        branch: branch.replace(/^refs\/heads\//, "") || head.slice(0, 7) || "HEAD",
        detached: !branch,
        main: list.length === 0,
      });
      if (list.length >= MAX_WORKTREES) break;
    }
    return list;
  } catch {
    return [];
  }
}

/** Branches to fall back on when nothing more specific identifies the fork. */
const FALLBACK_BASES = ["main", "master", "dev", "develop"];

/**
 * What a worktree's changes should be measured against when the user hasn't
 * picked. An agent's worktree branch is cut from whatever the repo's own
 * checkout was on, so that branch is the best guess at the fork; the usual
 * long-lived names cover the case where it has since moved on.
 *
 * Only linked worktrees get one. The repo's own checkout keeps the working-tree
 * view it has always had — that is where you commit from, and silently
 * switching it to a branch compare would change what the panel means.
 */
function defaultBase(wt: Omit<GitWorktree, "files">, refs: string[], mainBranch: string): string | undefined {
  if (wt.main) return undefined;
  const candidates = [mainBranch, ...FALLBACK_BASES];
  return candidates.find((b) => b && b !== wt.branch && refs.includes(b));
}

/**
 * How many files a worktree has changed, for its switcher badge — the point of
 * the switcher is seeing at a glance which one the agent has been working in.
 * Counted the same way the panel lists rows, so the badge matches what opening
 * it shows.
 */
async function changedCount(root: string, base: string | undefined): Promise<number> {
  try {
    // Promise.all observes BOTH promises even when one rejects — awaiting them
    // sequentially let the first rejection skip the second await, stranding an
    // unhandled rejection that takes the whole server down (spawn git ENOENT
    // when the worktree directory was deleted behind our back, or git itself
    // is missing from the server's PATH).
    const [statusOut, trackedOut] = await Promise.all([
      git(["status", "--porcelain=v1", "-z"], root),
      base
        ? mergeBase(root, base).then((mb) => git(["diff", "--name-only", "-z", mb], root))
        : Promise.resolve(""),
    ]);
    const files = new Set(trackedOut.split("\0").filter(Boolean));
    const records = statusOut.split("\0");
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.length < 4) continue;
      // A rename/copy's OLD path arrives as its own NUL token; without this
      // skip it would be read as another record and counted as a second file.
      if ("RC".includes(record[0]) || "RC".includes(record[1])) i++;
      // Without a base only the working tree counts; with one, `diff` already
      // covered the tracked side and only untracked files are still missing.
      if (base && record[0] !== "?") continue;
      files.add(record.slice(3).replace(/\/$/, ""));
    }
    return files.size;
  } catch {
    return 0;
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

export interface GitScope {
  /**
   * Root of the worktree to report on, instead of the one containing the
   * terminal's cwd. Lets the panel follow an agent working in a sibling
   * worktree without the terminal having to cd there.
   */
  worktree?: string;
  /**
   * Branch to compare against. Absent means "decide for me" — see
   * `defaultBase`; the empty string means the user explicitly asked for the
   * working-tree view.
   */
  base?: string;
}

/**
 * Where the panel should read from: the requested worktree when it really is
 * one of this repo's, else the one containing `cwd`. Checking the request
 * against git's own list is also what stops the parameter from naming a
 * directory outside the repo.
 */
async function resolveScope(cwd: string, worktree?: string) {
  const cwdRoot = await repoRoot(cwd);
  if (!cwdRoot) return null;
  const worktrees = await listWorktrees(cwdRoot);
  const wanted = worktree ? path.resolve(worktree) : undefined;
  const selected = wanted ? worktrees.find((w) => w.path === wanted) : undefined;
  return { root: selected?.path ?? cwdRoot, worktrees, selected };
}

/**
 * Just enough repo shape for scoping UIs (the session-history browser): root,
 * branch, and the worktree list. gitOverview computes diff rows plus a
 * changed-files badge per worktree — seconds of git on a repo with many
 * worktrees — which a scope picker doesn't need.
 */
export async function worktreeOverview(cwd: string): Promise<
  { repo: false } | { repo: true; root: string; branch: string; worktrees: Omit<GitWorktree, "files">[] }
> {
  const root = await repoRoot(cwd);
  if (!root) return { repo: false };
  const [branch, worktrees] = await Promise.all([currentBranch(root), listWorktrees(root)]);
  return { repo: true, root, branch, worktrees };
}

/** Longest setup-command failure the dialog is asked to show. */
const WARNING_CAP = 500;

/**
 * Drop the task description into the new worktree as TODO.txt, and hide that
 * name from git: `info/exclude` (shared by every worktree of the repo, unlike
 * a committed .gitignore) is the local-only ignore list, so the note never
 * shows up as an untracked file — neither in this worktree's diff nor in
 * anyone else's.
 */
async function writeTodo(dir: string, root: string, todo: string) {
  fs.writeFileSync(path.join(dir, "TODO.txt"), todo.trimEnd() + "\n");
  const commonDir = path.resolve(root, (await git(["rev-parse", "--git-common-dir"], root)).trim());
  const infoDir = path.join(commonDir, "info");
  fs.mkdirSync(infoDir, { recursive: true });
  const exclude = path.join(infoDir, "exclude");
  const prev = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (!prev.split("\n").some((l) => l.trim() === "TODO.txt")) {
    fs.appendFileSync(exclude, (prev && !prev.endsWith("\n") ? "\n" : "") + "TODO.txt\n");
  }
}

/**
 * Run the user's setup command in the new worktree (copying dev-only config
 * files in is the typical use). It goes through the platform shell so one
 * line like `cp ../.env.development .` works as typed. Failure must not fail
 * the creation — the worktree exists and is usable — so it comes back as a
 * warning string for the dialog to show.
 */
async function runSetupCommand(dir: string, command: string): Promise<string | undefined> {
  try {
    await execAsync(command, { cwd: dir, timeout: 120_000, windowsHide: true });
    return undefined;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = err.stderr?.trim() || err.message || String(e);
    return detail.length > WARNING_CAP ? `${detail.slice(0, WARNING_CAP)}…` : detail;
  }
}

/**
 * Create a linked worktree on a NEW branch cut from `base` (the repo's HEAD
 * when omitted). The directory is a sibling of the main checkout named after
 * the branch, numbered when that name is taken — the client never picks a
 * path, so one can't be aimed outside the repo's neighborhood.
 *
 * With `todo` the description lands in the worktree as TODO.txt; with
 * `command` a setup command runs in it after creation. Both are best-effort
 * extras on an already-created worktree: their failures are collected into
 * `warning` rather than thrown.
 */
export async function addWorktree(
  cwd: string,
  branch: string,
  base: string | undefined,
  extras: { todo?: string; command?: string } = {},
): Promise<{ path: string; warning?: string }> {
  const root = await repoRoot(cwd);
  if (!root) throw new Error("Not inside a git repository.");
  if (!validRef(branch)) throw new Error(`Invalid branch name: ${branch}`);
  const refs = await listRefs(root);
  if (refs.includes(branch)) throw new Error(`Branch already exists: ${branch}`);
  if (base && (!validRef(base) || !refs.includes(base))) throw new Error(`Unknown base: ${base}`);

  const stem = `${path.basename(root)}-${branch.replace(/[^\w.-]+/g, "-")}`;
  let dir = path.join(path.dirname(root), stem);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(path.dirname(root), `${stem}-${n}`);

  await git(["worktree", "add", dir, "-b", branch, ...(base ? [base] : [])], root);

  const warnings: string[] = [];
  if (extras.todo?.trim()) {
    try {
      await writeTodo(dir, root, extras.todo);
    } catch (e) {
      warnings.push(`TODO.txt: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (extras.command?.trim()) {
    const failure = await runSetupCommand(dir, extras.command.trim());
    if (failure) warnings.push(failure);
  }
  return { path: dir, warning: warnings.length ? warnings.join("\n") : undefined };
}

/**
 * Remove a linked worktree. The target must come from git's own list (the
 * same guard resolveScope applies to reads) and must not be the main
 * checkout. The removal does NOT go through git: the directory is moved
 * aside (a rename is instant on the same volume, no matter how many files
 * node_modules has), `worktree prune` drops the now-dangling registration,
 * and the directory is deleted in the background. That sidesteps everything
 * git's own removal is finicky about — fresh untracked files, a missing
 * `.git` pointer (scaffolding emptied the directory), slow recursive
 * deletes. Uncommitted changes go with it: the confirmation dialog warns
 * about those, so there is no separate force gate. The one case that still
 * blocks removal is a process holding the directory open (a shell's cwd, a
 * dev server): the rename fails and the user is told.
 *
 * With `withBranch` the branch the worktree sat on is deleted too (`-D`,
 * no merged check — opting in accepts losing unmerged commits), which is
 * the common case for the throwaway worktrees this app creates; a detached
 * worktree has no branch and skips that step.
 */
export async function removeWorktree(cwd: string, worktree: string, withBranch = false): Promise<void> {
  const resolved = await resolveScope(cwd, worktree);
  if (!resolved) throw new Error("Not inside a git repository.");
  if (!resolved.selected) throw new Error("Not a worktree of this repository.");
  if (resolved.selected.main) throw new Error("The main checkout cannot be removed.");
  const target = resolved.selected;
  const root = resolved.worktrees[0].path;
  const trash = path.join(
    path.dirname(target.path),
    `.termany-trash-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    await fs.promises.rename(target.path, trash);
  } catch {
    throw new Error("The directory is in use by another process; close it and try again.");
  }
  // Slow part — tens of thousands of tiny files, worst on Windows — happens
  // after the request has already succeeded. A leftover trash dir on failure
  // is harmless.
  void fs.promises.rm(trash, { recursive: true, force: true }).catch(() => {});
  await git(["worktree", "prune"], root);
  if (!withBranch || target.detached) return;
  // Best-effort: the branch is only deleted when it is really a local
  // branch (a detached worktree's short sha is no ref), and a failure here
  // must not dress up an already-removed worktree as an error — the branch
  // can still be deleted from the compare picker.
  try {
    await git(["show-ref", "--verify", `refs/heads/${target.branch}`], root);
    await git(["branch", "-D", target.branch], root);
  } catch {
    /* not a local branch, or already gone — nothing to delete */
  }
}

/**
 * A plain branch delete refused because the branch has unmerged commits —
 * separated out so the endpoint can flag it and the dialog can offer the
 * force retry (`-D`) instead of just showing git's stderr.
 */
export class BranchNotMergedError extends Error {}

/**
 * Delete a local branch, from the compare picker's per-branch button — the
 * counterpart to removeWorktree, which deliberately leaves the branch behind.
 * The name must come from the repo's own refs and be a LOCAL branch (the refs
 * list also carries remote-tracking entries, which stay out of reach); beyond
 * that git's own checks are the guard rails — a branch checked out in any
 * worktree is refused, and an unmerged one needs `force` (`-d` vs `-D`).
 */
export async function deleteBranch(cwd: string, branch: string, force: boolean): Promise<void> {
  const root = await repoRoot(cwd);
  if (!root) throw new Error("Not inside a git repository.");
  if (!validRef(branch)) throw new Error(`Invalid branch name: ${branch}`);
  const refs = await listRefs(root);
  if (!refs.includes(branch)) throw new Error(`Unknown branch: ${branch}`);
  try {
    await git(["show-ref", "--verify", `refs/heads/${branch}`], root);
  } catch {
    throw new Error(`Not a local branch: ${branch}`);
  }
  try {
    await git(["branch", force ? "-D" : "-d", branch], root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not fully merged/.test(message)) throw new BranchNotMergedError(message);
    throw error;
  }
}

export async function gitOverview(cwd: string, scope: GitScope = {}): Promise<GitOverview> {
  const resolved = await resolveScope(cwd, scope.worktree);
  if (!resolved) return { repo: false, cwd };
  const { root, worktrees } = resolved;

  const [branch, refs] = await Promise.all([currentBranch(root), listRefs(root)]);
  const here = resolved.selected ?? worktrees.find((w) => w.path === root);
  const auto =
    scope.base === undefined && here ? defaultBase(here, refs, worktrees[0]?.branch ?? "") : undefined;
  const wanted = scope.base === undefined ? auto : scope.base;
  const useBase = wanted && validRef(wanted) && refs.includes(wanted) ? wanted : undefined;

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

  // Badges are only worth their git calls when there is a switcher to put them
  // on, so a plain single-checkout repo pays nothing for this feature.
  const badged =
    worktrees.length > 1
      ? await Promise.all(
          worktrees.map(async (w) => ({
            ...w,
            files: await changedCount(w.path, defaultBase(w, refs, worktrees[0].branch)),
          })),
        )
      : undefined;

  const overflow = rows.length > MAX_ROWS;
  return {
    repo: true,
    cwd,
    root,
    branch,
    ...(useBase ? { base: useBase } : {}),
    refs,
    rows: overflow ? rows.slice(0, MAX_ROWS) : rows,
    ...(overflow ? { overflow: true } : {}),
    ...(badged ? { worktrees: badged } : {}),
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

/** Files requested together, capped so one pathspec can't grow unbounded. */
const MAX_DIFF_FILES = 200;

export interface DiffRequest {
  path: string;
  oldPath?: string;
  section: Section;
}

/** Key a diff by the same identity the client groups rows under. */
const diffKey = (section: Section, filePath: string) => `${section}:${filePath}`;

/**
 * Split a multi-file diff into per-file chunks. Only a real header sits at
 * column 0 — every content line carries a "+", "-", or " " prefix — so the
 * anchored split can't be fooled by a file whose own text contains the marker.
 */
function splitDiff(out: string): string[] {
  return out
    .split(/^diff --git /m)
    .slice(1)
    .map((chunk) => `diff --git ${chunk}`);
}

/**
 * Diffs for many files in one shot: two git invocations per section rather
 * than one per file. The chunks come back in the same order git lists them in
 * `--numstat`, which is what pairs each chunk with its path — parsing the path
 * out of the `diff --git a/x b/x` header instead would be ambiguous for any
 * name containing a space.
 */
export async function gitDiffs(opts: GitScope & {
  cwd: string;
  files: DiffRequest[];
}): Promise<Record<string, GitDiff>> {
  const resolved = await resolveScope(opts.cwd, opts.worktree);
  if (!resolved) return {};
  const { root } = resolved;

  const out: Record<string, GitDiff> = {};
  const bySection = new Map<Section, DiffRequest[]>();
  for (const f of opts.files.slice(0, MAX_DIFF_FILES)) {
    if (!insideRoot(root, f.path)) continue;
    const list = bySection.get(f.section) ?? [];
    list.push(f);
    bySection.set(f.section, list);
  }

  await Promise.all(
    [...bySection].map(async ([section, files]) => {
      if (section === "untracked") {
        await Promise.all(
          files.map(async (f) => {
            const abs = insideRoot(root, f.path);
            if (abs) out[diffKey(section, f.path)] = await untrackedDiff(abs, f.path);
          }),
        );
        return;
      }

      const args: string[] = [];
      if (section === "staged") args.push("--cached");
      if (section === "changed") {
        if (!opts.base || !validRef(opts.base)) return;
        args.push(await mergeBase(root, opts.base));
      }
      // Rename detection pairs the two sides only if both are in the pathspec;
      // with just the new path git reports the change as a whole new file.
      const paths = files.flatMap((f) =>
        f.oldPath && insideRoot(root, f.oldPath) ? [f.path, f.oldPath] : [f.path],
      );
      const [text, numstat] = await Promise.all([
        git(["diff", "--no-color", ...args, "--", ...paths], root),
        git(["diff", "--numstat", "-z", ...args, "--", ...paths], root),
      ]);

      const order = [...parseNumstat(numstat).keys()];
      const chunks = splitDiff(text);
      // A mismatch means the tree moved under us between the two calls; fall
      // back to reporting nothing rather than pairing diffs to wrong files.
      if (order.length !== chunks.length) return;
      order.forEach((filePath, i) => {
        const chunk = chunks[i];
        out[diffKey(section, filePath)] = isBinaryDiff(chunk)
          ? { diff: "", binary: true }
          : cap(chunk);
      });
    }),
  );

  return out;
}
