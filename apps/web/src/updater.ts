import { isTauri } from "./env";

/**
 * Desktop self-update, backed by the Tauri updater plugin. The server side is
 * a static `latest.json` + signed `.app.tar.gz` on cdn.termany.sh, produced by
 * the release pipeline (scripts/release-mac.sh + the site's publish-release.sh).
 * Everything here no-ops in the browser build.
 */

export interface UpdateInfo {
  version: string;
  notes?: string;
}

/** The plugin's Update handle, kept between check and install. */
let pending: import("@tauri-apps/plugin-updater").Update | null = null;

/** Ask the endpoint whether a newer build exists. null = already current. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  pending = update;
  return { version: update.version, notes: update.body ?? undefined };
}

/** Download + install the pending update, reporting 0–100 progress. */
export async function installUpdate(onProgress: (pct: number) => void): Promise<void> {
  if (!pending) throw new Error("no update pending — call checkForUpdate first");
  let total = 0;
  let received = 0;
  await pending.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      // Hold 100% for "Finished" — install work continues after the download.
      if (total) onProgress(Math.min(99, Math.round((received / total) * 100)));
    } else if (event.event === "Finished") {
      onProgress(100);
    }
  });
}

/** Restart into the freshly installed version. */
export async function relaunchApp(): Promise<void> {
  // Terminal sessions otherwise survive an ordinary quit + relaunch (the
  // bundled server keeps running across it — see the desktop lib.rs). An
  // update swaps the server binary itself, so stop the old one explicitly
  // here; otherwise the new app build would reconnect to stale server code.
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("stop_server").catch(() => {});
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
