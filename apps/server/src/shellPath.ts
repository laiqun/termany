import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === "win32";

/** Sentinel so rc-file chatter on stdout can't be mistaken for the answer. */
const MARKER = "__termany_shell__";

function loginShell(): string {
  return process.env.SHELL || (IS_WIN ? "cmd.exe" : "/bin/zsh");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function capture(stdout: string): string | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(MARKER))
    .pop();
  const value = line?.slice(MARKER.length).trim();
  return value || undefined;
}

/**
 * Evaluate a shell expression in the user's login shell and return its value.
 *
 * `-lc` alone is not enough: a non-interactive zsh reads .zshenv, .zprofile and
 * .zlogin but *skips ~/.zshrc*, which is exactly where CLI installers (opencode,
 * pnpm, nvm, ~/.local/bin) append to PATH. Terminal panes never hit this because
 * node-pty hands the shell a tty, so `zsh -l` is interactive there. Retry with
 * `-i` whenever the quiet pass comes back empty so both worlds see one PATH.
 */
async function loginShellValue(expression: string): Promise<string | undefined> {
  const shell = loginShell();
  const script = `printf '%s%s\\n' ${shellQuote(MARKER)} "${expression}"`;
  for (const flags of ["-lc", "-lic"]) {
    try {
      const { stdout } = await execFileAsync(shell, [flags, script], {
        timeout: 5_000,
        // An interactive rc file can print a banner; keep it from blowing up.
        maxBuffer: 1_024 * 1_024,
      });
      const value = capture(stdout);
      if (value) return value;
    } catch {
      // Try the next form; the caller reports the failure in context.
    }
  }
  return undefined;
}

let cachedPath: Promise<string | undefined> | undefined;

/**
 * The PATH a login terminal would see, cached for the life of the process.
 *
 * Child agents spawned by the server inherit the app's environment, which in a
 * Finder-launched macOS bundle is the bare launchd PATH — no node, no npx, no
 * user bin directories.
 */
export function loginShellPath(): Promise<string | undefined> {
  if (IS_WIN) return Promise.resolve(undefined);
  cachedPath ??= loginShellValue("$PATH").catch(() => undefined);
  return cachedPath;
}

/** PATH-repaired environment for a child process spawned outside a PTY. */
export async function spawnEnvironment(): Promise<NodeJS.ProcessEnv> {
  const path = await loginShellPath();
  return path ? { ...process.env, PATH: path } : { ...process.env };
}

/**
 * Absolute path of `command`, resolved the way the user's shell would.
 * Returns undefined when nothing matches.
 */
export async function resolveExecutable(command: string): Promise<string | undefined> {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (/[\\/]/.test(trimmed)) {
    try {
      await fs.promises.access(trimmed, fs.constants.X_OK);
      return trimmed;
    } catch {
      return undefined;
    }
  }
  if (IS_WIN) {
    try {
      const { stdout } = await execFileAsync("where.exe", [trimmed], { timeout: 2_500 });
      return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    } catch {
      return undefined;
    }
  }
  return loginShellValue(`$(command -v -- ${shellQuote(trimmed)} 2>/dev/null)`);
}
