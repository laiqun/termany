import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { isTauri } from "./env";

/** Open a URL in the system browser (desktop) or a new tab (web). Returns an
 *  error message on failure (so a dead click surfaces a reason), null on ok. */
export async function openExternal(url: string): Promise<string | null> {
  try {
    if (isTauri) await openUrl(url);
    else window.open(url, "_blank", "noopener,noreferrer");
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Reveal a local file/folder in Finder/Explorer. Browser builds cannot access
 *  arbitrary local paths, so this is desktop-only. */
export async function revealPath(path: string): Promise<string | null> {
  try {
    if (!isTauri) return "local file reveal is only available in the desktop app";
    await revealItemInDir(path);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
