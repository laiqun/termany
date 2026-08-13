import { apiPath } from "./api";
import { useStore } from "./state/store";

/**
 * Validate a typed directory path through the file-tree listing endpoint,
 * which also expands a leading "~" and returns the normalized absolute path.
 * Resolves to:
 *  - `undefined` for an empty input, or when the path IS home — both mean
 *    "home", stored as undefined so persisted layouts stay machine-portable;
 *  - the normalized absolute path otherwise;
 *  - `null` when the path is not a directory (or the server can't be asked).
 */
export async function resolveDirCwd(raw: string): Promise<string | undefined | null> {
  const value = raw.trim();
  if (!value) return undefined;
  try {
    const res = await fetch(apiPath(`/api/fs/list?path=${encodeURIComponent(value)}`));
    if (!res.ok) return null;
    const data = (await res.json()) as { path?: string };
    if (!data.path) return null;
    return data.path === useStore.getState().homeDir ? undefined : data.path;
  } catch {
    return null;
  }
}

/**
 * Resolve the machine's home directory once (via the same listing endpoint's
 * "~" expansion) and stash it in the store, where homeLabel reads it.
 * Best-effort: until it lands, labels fall back to "~".
 */
export async function resolveHomeDir(): Promise<void> {
  try {
    const res = await fetch(apiPath(`/api/fs/list?path=${encodeURIComponent("~")}`));
    if (!res.ok) return;
    const data = (await res.json()) as { path?: string };
    if (data.path) useStore.getState().setHomeDir(data.path);
  } catch {
    /* no server reachable — labels stay "~" */
  }
}

/**
 * Directory spelling never carries meaning: `\` vs `/`, a trailing slash, and
 * — when a drive letter says Windows — case.
 */
function normDir(p: string): string {
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(n) ? n.toLowerCase() : n;
}

/** Directory comparison for matching a worktree's root against a tab's cwd. */
export function sameDir(a: string, b: string): boolean {
  return normDir(a) === normDir(b);
}

/** True when `dir` is `root` itself or somewhere beneath it. */
export function inDir(root: string, dir: string): boolean {
  const r = normDir(root);
  const d = normDir(dir);
  return d === r || d.startsWith(r + "/");
}

/** The cheap repo shape GET /api/git/worktrees returns for a directory. */
export interface WorktreeScope {
  repo: true;
  /** Repo root containing the asked-for directory — its worktree's path when
   *  the directory sits inside a linked worktree. */
  root: string;
  branch: string;
  refs: string[];
  worktrees: Array<{
    path: string;
    name: string;
    branch: string;
    detached?: boolean;
    main: boolean;
  }>;
  /** Changed-files count of the containing worktree, present only when asked
   *  for (`files`) and the directory sits in a linked worktree. */
  files?: number;
}

/**
 * The repo shape around a directory, or null when it isn't inside a repo (or
 * the server can't be asked). Backs the new-tab dialog's worktree offer and
 * the tab-close worktree check.
 */
export async function fetchWorktreeScope(cwd: string, opts?: { files?: boolean }): Promise<WorktreeScope | null> {
  const params = new URLSearchParams({ cwd });
  if (opts?.files) params.set("files", "1");
  try {
    const res = await fetch(apiPath(`/api/git/worktrees?${params}`));
    if (!res.ok) return null;
    const data = (await res.json()) as WorktreeScope | { repo: false };
    return data.repo ? data : null;
  } catch {
    return null;
  }
}
