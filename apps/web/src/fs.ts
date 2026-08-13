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
