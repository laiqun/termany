import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Escape a string into an AppleScript double-quoted literal. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Open the OS-native "choose a folder" dialog and return the picked absolute
 * path, or null when the user cancels. The server runs on the user's own
 * machine (Tauri shell or `npm run dev`), so the dialog appears locally even
 * when the UI itself lives in a browser tab.
 */
export async function pickFolder(prompt: string, defaultPath?: string): Promise<string | null> {
  if (process.platform === "darwin") {
    const choose = defaultPath
      ? `POSIX path of (choose folder with prompt ${appleScriptString(prompt)} default location (POSIX file ${appleScriptString(defaultPath)}))`
      : `POSIX path of (choose folder with prompt ${appleScriptString(prompt)})`;
    try {
      // Show the dialog immediately; blocking on `tell me to activate` first
      // costs ~3s. The parallel System Events nudge fronts the panel shortly
      // after in the rare case it opens behind the app window.
      const pending = execFileAsync("osascript", ["-e", choose], { timeout: 300_000 });
      execFileAsync("osascript", [
        "-e",
        'tell application "System Events" to set frontmost of (first process whose name is "osascript") to true',
      ]).catch(() => undefined);
      const { stdout } = await pending;
      const picked = stdout.trim();
      return picked || null;
    } catch (error) {
      const detail = error instanceof Error ? String((error as { stderr?: string }).stderr ?? error.message) : String(error);
      if (detail.includes("-128")) return null; // user canceled
      throw new Error(`Folder dialog failed: ${detail.trim()}`);
    }
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
      `$d.Description = '${prompt.replace(/'/g, "''")}';`,
      defaultPath ? `$d.SelectedPath = '${defaultPath.replace(/'/g, "''")}';` : "",
      "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }",
    ].join(" ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 300_000 });
    return stdout.trim() || null;
  }

  // Linux: best effort via zenity; a missing binary surfaces as a clear error.
  try {
    const args = ["--file-selection", "--directory", `--title=${prompt}`];
    if (defaultPath) args.push(`--filename=${defaultPath.endsWith("/") ? defaultPath : `${defaultPath}/`}`);
    const { stdout } = await execFileAsync("zenity", args, { timeout: 300_000 });
    return stdout.trim() || null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 1) return null; // canceled
    throw new Error("Folder dialog needs zenity on this system");
  }
}
