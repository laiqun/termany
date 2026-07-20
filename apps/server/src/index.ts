import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
// Where api.anthropic.com is region-blocked, users run a local proxy (HTTPS_PROXY).
// Node's global fetch — which the Anthropic SDK uses — ignores proxy env vars by
// default, so route it through them explicitly. No-op when no proxy env is set.
setGlobalDispatcher(new EnvHttpProxyAgent());

import { spawn } from "node-pty";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { listAgentSessions, listAgentUsage, warmAgentSessionCache } from "./agentSessions.js";
import { readSystemStats } from "./systemStats.js";
import { WebSocketServer, type WebSocket } from "ws";
import { listConfig, saveConfig } from "./config.js";
import {
  forgetSessions,
  getAllScreens,
  getAllScroll,
  getScroll,
  getSessionCwd,
  loadState,
  saveState,
  setScreenBatch,
  setScrollBatch,
  setSessionCwd,
} from "./db.js";
import { gitDiff, gitOverview } from "./git.js";
import { testProvider } from "./providerTest.js";
import { generateTheme } from "./theme.js";

/** Read a JSON request body (capped) into an object. */
function readJson(req: import("node:http").IncomingMessage, maxChars = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxChars) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readBuffer(
  req: import("node:http").IncomingMessage,
  maxBytes = 20_000_000
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function mediaTypeForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    ".apng": "image/apng",
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return types[ext] ?? null;
}

/**
 * The PTY server. One WebSocket connection == one shell session.
 *
 * Today it runs locally and spawns a shell on this machine. The SAME server,
 * moved behind auth + a container-per-session sandbox, becomes the cloud
 * backend — the web frontend doesn't change a line. That's the whole point of
 * keeping the PTY behind WebSocketBackend.
 */

// Dev runs on 5175 so it never collides with an INSTALLED Termany.app, whose
// bundled server owns 5174 — that collision used to kill the dev server
// silently mid-`pnpm desktop`, leaving the dev app talking to the old binary.
// `npm_lifecycle_event` is "dev" only when launched via the `dev` script.
const DEFAULT_PORT = process.env.npm_lifecycle_event === "dev" ? 5175 : 5174;
const PORT = Number(process.env.TERMANY_PORT ?? DEFAULT_PORT);
/**
 * Baked in at bundle time by scripts/bundle-server.mjs (esbuild --define) so a
 * packaged server can report which build it belongs to. The desktop app rejects
 * a running server whose version doesn't match its own — see
 * existing_server_matches() in apps/desktop/src-tauri/src/lib.rs. Undefined when
 * run from source (tsx), where "dev" never matches a release app on purpose.
 */
declare const __TERMANY_VERSION__: string | undefined;
const SERVER_VERSION = typeof __TERMANY_VERSION__ === "string" ? __TERMANY_VERSION__ : "dev";
const IS_WIN = os.platform() === "win32";
const PASTE_DIR = process.env.TERMANY_PASTE_DIR ?? `${os.tmpdir()}/termany-pastes`;
// Launch a LOGIN shell so it runs /etc/zprofile + ~/.zprofile (Homebrew's
// `brew shellenv`, fnm/pyenv/etc.) — a GUI app inherits only a minimal PATH,
// so without this the user's profile hits "command not found".
const execFileAsync = promisify(execFile);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function firstShellToken(input: string): string {
  const trimmed = input.trim();
  const match = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(trimmed);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

async function detectExecutable(command: string): Promise<{ command: string; installed: boolean; path?: string }> {
  const executable = firstShellToken(command);
  if (!executable) return { command, installed: false };
  if (/[\\/]/.test(executable)) {
    try {
      await fs.promises.access(executable, fs.constants.X_OK);
      return { command, installed: true, path: executable };
    } catch {
      return { command, installed: false };
    }
  }

  try {
    const { stdout } = IS_WIN
      ? await execFileAsync("where.exe", [executable], { timeout: 2500 })
      : await execFileAsync(SHELL, ["-lc", `command -v -- ${shellQuote(executable)}`], { timeout: 2500 });
    const found = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return found ? { command, installed: true, path: found } : { command, installed: false };
  } catch {
    return { command, installed: false };
  }
}

function windowsPowerShellPath(): string {
  const root = process.env.SystemRoot || "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function defaultShell(): string {
  if (process.env.TERMANY_SHELL) return process.env.TERMANY_SHELL;
  if (IS_WIN) return windowsPowerShellPath();
  return process.env.SHELL || "zsh";
}

const SHELL = defaultShell();
// Windows has no equivalent of /proc/pid/cwd or `lsof -d cwd` (see cwdForPid
// below), so the shell's live directory is unknowable from OUTSIDE the
// process. Instead we make PowerShell tell us: every time it draws a prompt,
// this hook emits an OSC 7 escape (the same "report cwd" convention iTerm2/VS
// Code/GNOME Terminal use) carrying a file:// URI of the current directory.
// trackOscCwd() below watches the raw PTY stream for it. `-NoProfile` means
// there's no user `prompt` function to preserve, so overwriting it outright
// is safe.
const OSC7_PS_HOOK = [
  "function prompt {",
  "  $u = [uri]::new((Get-Location).ProviderPath)",
  "  $e = [char]27",
  '  Write-Host -NoNewline ("$e]7;" + $u.AbsoluteUri + "$e\\")',
  "  \"PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) \"",
  "}",
].join("\n");
// Windows PowerShell profiles commonly initialize prompt tooling, package
// managers, network drives, or Conda. In a headless packaged app that can turn
// a new terminal into a minutes-long hang before the interactive prompt exists.
const SHELL_ARGS = IS_WIN
  ? ["-NoLogo", "-NoProfile", "-NoExit", "-Command", OSC7_PS_HOOK]
  : ["-l"];

// Populated from the PTY's own output (Windows only — see OSC7_PS_HOOK above),
// keyed by pid so cwdForPid() can serve it the same way it serves the native
// lookups on Linux/macOS. Cleared as sessions exit in wireSession() below.
const oscCwdByPid = new Map<number, string>();
const OSC7_RE = /\x1b\]7;file:\/\/[^/\x07\x1b]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Scan a chunk of raw PTY output for an OSC 7 cwd report and cache the latest. */
function trackOscCwd(pid: number, data: string): void {
  let last: string | undefined;
  for (const match of data.matchAll(OSC7_RE)) last = match[1];
  if (!last) return;
  try {
    let decoded = decodeURIComponent(last);
    // file:///C:/Users/... — strip the URI's leading slash before the drive letter.
    if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
    oscCwdByPid.set(pid, decoded);
  } catch {
    /* malformed percent-encoding (e.g. a literal "%" in the path) — ignore */
  }
}

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

// --- scroll history ---------------------------------------------------------
// Every live session tails its raw PTY output into a per-session ring
// (Wave-style: history survives restarts without the frontend serializing
// anything). Each ring is capped at SCROLL_CAP bytes and flushes to SQLite
// every 10s, on detach, and on a pagehide beacon from the frontend (the app may
// SIGKILL us on quit, so the timed flush alone isn't enough).

const SCROLL_CAP = 512 * 1024; // raw bytes/session ≈ a few thousand visible lines

interface ScrollRing {
  chunks: string[];
  bytes: number;
  dirty: boolean;
}

/** A fresh ring for `sessionId`, seeded from its saved history so runs concatenate. */
function newRing(sessionId: string): ScrollRing {
  const saved = getScroll(sessionId) ?? "";
  return { chunks: saved ? [saved] : [], bytes: Buffer.byteLength(saved), dirty: false };
}

function ringAppend(ring: ScrollRing, data: string): void {
  ring.chunks.push(data);
  ring.bytes += Buffer.byteLength(data);
  ring.dirty = true;
  if (ring.bytes <= SCROLL_CAP) return;
  // Overflow: drop whole chunks from the head, then cut the new head to a line
  // boundary so a replay never starts mid-escape-sequence.
  while (ring.bytes > SCROLL_CAP && ring.chunks.length > 1) {
    ring.bytes -= Buffer.byteLength(ring.chunks.shift()!);
  }
  const head = ring.chunks[0];
  if (ring.bytes > SCROLL_CAP) {
    // A single oversized chunk (e.g. `cat` of a huge file) — keep its tail.
    ring.chunks[0] = head.slice(-SCROLL_CAP);
    ring.bytes = Buffer.byteLength(ring.chunks[0]);
  }
  const nl = ring.chunks[0].indexOf("\n");
  if (nl >= 0 && nl < ring.chunks[0].length - 1) {
    ring.bytes -= Buffer.byteLength(ring.chunks[0].slice(0, nl + 1));
    ring.chunks[0] = ring.chunks[0].slice(nl + 1);
  }
}

/**
 * Make raw PTY output safe to replay into a fresh terminal: strip sequences
 * that would make xterm.js answer back into the NEW shell (device/status
 * queries) or cause side effects (clipboard writes). Heuristic by design —
 * anything it misses is neutralised by the client's post-replay reset.
 */
function sanitizeForReplay(data: string): string {
  return (
    data
      // DCS strings (XTGETTCAP etc.) — queries wrapped in ESC P ... ESC \
      .replace(/\x1bP[\s\S]*?(?:\x1b\\|\x07)/g, "")
      // OSC 52 — replaying it would overwrite the user's clipboard
      .replace(/\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // OSC color queries (]10;? / ]11;? …) — xterm.js replies to these
      .replace(/\x1b\](?:1[0-9]|4);[^\x07\x1b]*\?[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // CSI queries with replies: DSR/CPR (final `n`), DA1/DA2/DA3 (final `c`)
      .replace(/\x1b\[[?>=]?[0-9;]*[nc]/g, "")
      // XTVERSION, DECRQM, kitty keyboard query
      .replace(/\x1b\[>[0-9;]*q/g, "")
      .replace(/\x1b\[\?[0-9;]*\$p/g, "")
      .replace(/\x1b\[\?u/g, "")
      // ED3 (erase scrollback) and RIS (full reset) — replayed verbatim they'd
      // destroy the restored history itself
      .replace(/\x1b\[3J/g, "")
      .replace(/\x1bc/g, "")
      // Interactive-mode ENABLES (focus reporting 1004, mouse 100x/1015,
      // bracketed paste 2004, kitty keyboard). Replaying one arms the mode on
      // the fresh terminal, and any focus/mouse event fired before the client's
      // post-replay reset lands goes to the NEW shell as garbage input (the
      // echoed `^[[I` then gets captured into history — compounding forever).
      .replace(
        /\x1b\[\?(?:[0-9]{1,4};)*(?:100[0-6]|1015|1016|2004)(?:;[0-9]{1,4})*h/g,
        ""
      )
      .replace(/\x1b\[[><][0-9;]*u/g, "")
  );
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

function normalizeImageType(value: string): string {
  const type = value.toLowerCase();
  if (type === "public.jpeg" || type === "public.jpg") return "image/jpeg";
  if (type === "public.png") return "image/png";
  if (type === "public.tiff") return "image/tiff";
  if (type === "org.webmproject.webp") return "image/webp";
  return type;
}

async function writePastedImage(mime: string, data: Buffer): Promise<{ path: string }> {
  const ext = IMAGE_EXT_BY_MIME[normalizeImageType(mime)];
  if (!ext) throw new Error("unsupported image type");
  if (!data.byteLength) throw new Error("image data is required");

  await fs.promises.mkdir(PASTE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = `${PASTE_DIR}/paste-${stamp}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await fs.promises.writeFile(filePath, data);
  return { path: filePath };
}

async function savePastedImage(body: any): Promise<{ path: string }> {
  const mime = String(body.type ?? "").toLowerCase();
  const data = String(body.data ?? "");
  return writePastedImage(mime, Buffer.from(data, "base64"));
}

// --- PTY session registry ---------------------------------------------------
// A session's shell now outlives its WebSocket: closing/reloading the webview
// (or quitting and reopening the app, as long as this server process stays up
// — see the desktop side's window/lifecycle handling) detaches the socket but
// leaves the PTY running, so a reconnect resumes the SAME live process instead
// of spawning a fresh one. Only two things actually end a session's PTY:
//   - the shell exits on its own (user typed `exit`, process crashed)
//   - the pane is explicitly closed (POST /api/forget) or it's been detached
//     longer than DETACH_TTL_MS (a safety net against orphaned shells piling
//     up forever if the app is never reopened)

interface PtySession {
  pty: ReturnType<typeof spawn>;
  ring: ScrollRing;
  ws: WebSocket | null;
  detachedAt: number | null;
}

const ptySessions = new Map<string, PtySession>();
// Connections without a session id (defensive fallback only — the frontend
// always sends one) get no restore/reattach semantics: killed on disconnect,
// same as every session used to behave before reattach existed.
const ephemeralSessions = new Set<PtySession>();

function isOpen(ws: WebSocket | null): ws is WebSocket {
  return !!ws && ws.readyState === ws.OPEN;
}

/** Wire a freshly spawned pty's output into its ring + whatever ws is attached. */
function wireSession(id: string | undefined, session: PtySession): void {
  session.pty.onData((data) => {
    if (isOpen(session.ws)) session.ws.send(data);
    ringAppend(session.ring, data);
    if (IS_WIN) trackOscCwd(session.pty.pid, data);
  });
  session.pty.onExit(({ exitCode, signal }) => {
    oscCwdByPid.delete(session.pty.pid);
    console.error(
      `[termany] shell exited (pid: ${session.pty.pid}, code: ${exitCode}, signal: ${signal ?? "none"})`
    );
    if (isOpen(session.ws)) {
      session.ws.send(
        `\r\n\x1b[2m[termany] shell exited (code: ${exitCode}, signal: ${signal ?? "none"})\x1b[0m\r\n`
      );
      session.ws.close();
    }
    if (id) {
      // Natural exit — flush final history so it still restores as plain
      // scrollback (cwd/history stay in the DB; only /api/forget wipes them).
      if (session.ring.dirty) {
        try {
          setScrollBatch({ [id]: session.ring.chunks.join("") });
        } catch {
          /* best-effort */
        }
      }
      ptySessions.delete(id);
    } else {
      ephemeralSessions.delete(session);
    }
  });
}

/** Kill a session's live process (if any), preserving its restore history. */
function killSession(id: string): void {
  const session = ptySessions.get(id);
  if (!session) return;
  if (session.ring.dirty) {
    try {
      setScrollBatch({ [id]: session.ring.chunks.join("") });
    } catch {
      /* best-effort */
    }
  }
  try {
    session.pty.kill();
  } catch {
    /* already gone */
  }
  ptySessions.delete(id);
}

// Safety net: a shell detached (app closed, never reopened) longer than this
// is reaped so orphaned processes don't accumulate forever. Its restore
// history is left in place — reopening later still shows the last output.
const DETACH_TTL_MS = Number(process.env.TERMANY_DETACH_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);

function reapDetachedSessions(): void {
  const now = Date.now();
  for (const [id, session] of ptySessions) {
    if (session.detachedAt !== null && now - session.detachedAt > DETACH_TTL_MS) {
      console.log(
        `[termany] reaping session ${id}, detached for over ${Math.round(DETACH_TTL_MS / 86_400_000)}d`
      );
      killSession(id);
    }
  }
}
setInterval(reapDetachedSessions, 60 * 60 * 1000).unref();

/** Persist every dirty ring; coalesces each into one string as a side effect. */
function flushScroll(): void {
  const batch: Record<string, string> = {};
  for (const [id, session] of ptySessions) {
    if (!session.ring.dirty) continue;
    const data = session.ring.chunks.join("");
    session.ring.chunks = [data]; // coalesce: fewer live string objects between flushes
    session.ring.dirty = false;
    batch[id] = data;
  }
  try {
    setScrollBatch(batch);
  } catch (err) {
    console.error("[termany] scroll flush failed:", err);
  }
}

setInterval(flushScroll, 10_000).unref();

// One HTTP server hosts both the WebSocket upgrade (PTY sessions) and a small
// JSON API (POST /api/theme — AI theme generation, key stays server-side).
const http = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Image-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const json = (code: number, payload: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const fail = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[termany] request failed:", msg);
    json(500, { error: msg });
  };
  const reqUrl = new URL(req.url ?? "/", "http://localhost");

  // Model-provider settings (keys stored server-side, masked on read).
  if (req.method === "GET" && req.url === "/api/models") {
    json(200, listConfig());
    return;
  }
  if (req.method === "PUT" && req.url === "/api/models") {
    readJson(req)
      .then((body) => {
        saveConfig(body);
        json(200, listConfig());
      })
      .catch(fail);
    return;
  }
  // Connectivity check for a provider before it is saved. The key stays here:
  // an edit can omit it and the stored one is resolved by provider id.
  if (req.method === "POST" && req.url === "/api/models/test") {
    readJson(req)
      .then(async (body) =>
        json(200, await testProvider({
          kind: body?.kind === "anthropic" ? "anthropic" : "openai",
          apiBase: String(body?.apiBase ?? ""),
          apiKey: String(body?.apiKey ?? ""),
          model: String(body?.model ?? ""),
          providerId: body?.providerId ? String(body.providerId) : undefined,
        }))
      )
      .catch(fail);
    return;
  }

  // Detect local agent CLIs using the same login-shell PATH that terminal panes use.
  if (req.method === "POST" && req.url === "/api/agents/detect") {
    readJson(req)
      .then(async (body) => {
        const commands = Array.isArray(body?.commands) ? body.commands.slice(0, 64).map(String) : [];
        const unique = [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
        json(200, { results: await Promise.all(unique.map(detectExecutable)) });
      })
      .catch(fail);
    return;
  }

  // Workspace/tab layout (SQLite-backed). The webview is just a reflection.
  if (req.method === "GET" && req.url === "/api/state") {
    json(200, loadState());
    return;
  }
  if (req.method === "PUT" && req.url === "/api/state") {
    readJson(req)
      .then((body) => {
        saveState(body);
        json(200, { ok: true });
      })
      .catch(fail);
    return;
  }

  // Terminal scroll history — every live session tails its raw PTY output (see
  // the ring machinery above), so restore is one sanitized read. Sessions that
  // quit inside a TUI's alternate screen get their captured final screen
  // appended AFTER leaving the alt screen, so it survives as plain history
  // (the alt screen itself is discarded on replay, by terminal semantics).
  if (req.method === "GET" && req.url === "/api/scroll") {
    const merged = getAllScroll();
    for (const [id, session] of ptySessions) merged[id] = session.ring.chunks.join("");
    for (const id of Object.keys(merged)) merged[id] = sanitizeForReplay(merged[id]);
    for (const [id, text] of Object.entries(getAllScreens())) {
      merged[id] =
        (merged[id] ?? "") +
        "\x1b[?1049l\x1b[0m\r\n\x1b[2m── screen at last quit ──\x1b[0m\r\n" +
        text +
        "\r\n";
    }
    json(200, merged);
    return;
  }
  // sendBeacon target: persist all in-memory history NOW — the window is going
  // away and the app may SIGKILL this server before the next timed flush. The
  // body (optional) carries final-screen captures of sessions inside a TUI;
  // null entries clear a stale capture for sessions back on the primary screen.
  if (req.method === "POST" && req.url === "/api/scroll/flush") {
    readJson(req)
      .then((body) => {
        setScreenBatch(body?.screens ?? {});
        flushScroll();
        res.writeHead(204).end();
      })
      .catch(fail);
    return;
  }
  // Permanently drop restore data (cwd + scroll history) for closed panes, and
  // kill their live process if one is still running (detached or attached).
  if (req.method === "POST" && req.url === "/api/forget") {
    readJson(req)
      .then((body) => {
        const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
        for (const id of ids) killSession(id);
        forgetSessions(ids);
        json(200, { ok: true });
      })
      .catch(fail);
    return;
  }

  // Paths clicked in terminal output. Relative paths (compiler/test output
  // like `src/foo.ts`) only mean something against the session shell's LIVE
  // cwd, which only this process can see — resolve each candidate here, stat
  // it, and hand back an absolute path (or null so the client draws no link).
  if (req.method === "POST" && req.url === "/api/resolve-paths") {
    readJson(req)
      .then(async (body) => {
        const sessionId = String(body?.session ?? "");
        const paths = Array.isArray(body?.paths) ? body.paths.slice(0, 64).map(String) : [];
        const pty = ptySessions.get(sessionId)?.pty;
        const cwd =
          (await dirIfValid(pty ? await cwdForPid(pty.pid) : undefined)) ??
          (await dirIfValid(getSessionCwd(sessionId) ?? undefined)) ??
          os.homedir();
        const resolved = await Promise.all(
          paths.map(async (p: string) => {
            let abs = p;
            if (p === "~" || p.startsWith("~/")) abs = path.join(os.homedir(), p.slice(1));
            else if (!path.isAbsolute(p)) abs = path.resolve(cwd, p);
            try {
              await fs.promises.stat(abs);
              return abs;
            } catch {
              return null;
            }
          })
        );
        json(200, { resolved });
      })
      .catch(fail);
    return;
  }

  // Directory listing for the per-pane file tree. `session` anchors an empty
  // `path` to that pane's shell's LIVE cwd (same resolution as resolve-paths);
  // an explicit `path` just lists that directory instead.
  if (req.method === "GET" && reqUrl.pathname === "/api/fs/list") {
    (async () => {
      const sessionId = reqUrl.searchParams.get("session") ?? "";
      const requested = reqUrl.searchParams.get("path");
      let dir = requested?.trim();
      // Expand a leading "~" (bare, or "~/…") — typed manually into the file
      // tree's address bar, this is the one place a user-facing path needs it.
      if (dir === "~") dir = os.homedir();
      else if (dir?.startsWith("~/")) dir = path.join(os.homedir(), dir.slice(2));
      if (!dir) {
        const pty = ptySessions.get(sessionId)?.pty;
        dir =
          (await dirIfValid(pty ? await cwdForPid(pty.pid) : undefined)) ??
          (await dirIfValid(getSessionCwd(sessionId) ?? undefined)) ??
          os.homedir();
      }
      dir = path.resolve(dir);
      const names = await fs.promises.readdir(dir, { withFileTypes: true });
      const entries = await Promise.all(
        names.map(async (d) => {
          let isDir = d.isDirectory();
          let size = 0;
          let mtimeMs = 0;
          try {
            const st = await fs.promises.stat(path.join(dir!, d.name));
            isDir = st.isDirectory();
            size = st.size;
            mtimeMs = st.mtimeMs;
          } catch {
            /* broken symlink or a race with a deleted entry — list it inert */
          }
          return { name: d.name, isDir, size, mtimeMs };
        })
      );
      entries.sort((a, b) =>
        a.isDir === b.isDir
          ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
          : a.isDir
            ? -1
            : 1
      );
      const parent = path.dirname(dir);
      json(200, { path: dir, parent: parent === dir ? null : parent, entries });
    })().catch(fail);
    return;
  }

  // Metadata for a path dropped from the OS into a terminal pane. The frontend
  // uses this to decide whether to open a file-tree root or a file preview.
  if (req.method === "GET" && reqUrl.pathname === "/api/fs/stat") {
    (async () => {
      const requested = reqUrl.searchParams.get("path");
      if (!requested) throw new Error("path is required");
      const abs = path.resolve(requested);
      const st = await fs.promises.stat(abs);
      json(200, {
        path: abs,
        isDir: st.isDirectory(),
        isFile: st.isFile(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    })().catch(fail);
    return;
  }

  // Stream previewable local media. Supports Range so videos/audio can seek
  // and large files are not buffered into memory.
  if (req.method === "GET" && reqUrl.pathname === "/api/fs/media") {
    (async () => {
      const requested = reqUrl.searchParams.get("path");
      if (!requested) throw new Error("path is required");
      const abs = path.resolve(requested);
      const contentType = mediaTypeForPath(abs);
      if (!contentType) throw new Error("unsupported media type");
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) throw new Error("not a file");

      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
          res.end();
          return;
        }
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "Content-Type": contentType,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(abs).pipe(res);
    })().catch(fail);
    return;
  }

  // Read a file's text for the in-pane viewer (double-click in the file tree).
  // Capped and binary-sniffed — this is a preview, not a general file-serving
  // endpoint — so huge or non-text files don't get read into memory whole.
  const FILE_READ_CAP = 2 * 1024 * 1024;
  if (req.method === "GET" && reqUrl.pathname === "/api/fs/read") {
    (async () => {
      const requested = reqUrl.searchParams.get("path");
      if (!requested) throw new Error("path is required");
      const abs = path.resolve(requested);
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) throw new Error("not a file");
      const readLen = Math.min(stat.size, FILE_READ_CAP);
      const buf = Buffer.alloc(readLen);
      const fd = await fs.promises.open(abs, "r");
      try {
        await fd.read(buf, 0, readLen, 0);
      } finally {
        await fd.close();
      }
      // A NUL byte anywhere in the sample means "not text" — same heuristic
      // git/grep use to skip binary files.
      if (buf.includes(0)) {
        json(200, { binary: true, size: stat.size });
        return;
      }
      json(200, { content: buf.toString("utf8"), truncated: stat.size > FILE_READ_CAP, size: stat.size });
    })().catch(fail);
    return;
  }

  // Save the in-pane editor's content back to disk (⌘S in the file preview).
  if (req.method === "PUT" && reqUrl.pathname === "/api/fs/write") {
    readJson(req)
      .then(async (body) => {
        const requested = String(body?.path ?? "");
        if (!requested) throw new Error("path is required");
        const content = String(body?.content ?? "");
        await fs.promises.writeFile(path.resolve(requested), content, "utf8");
        json(200, { ok: true });
      })
      .catch(fail);
    return;
  }

  // Locally installed CodexThemes packages (~/.codexthemes/themes): list each
  // package's manifest plus artwork/preview file paths, so Appearance can show
  // a one-click gallery. Images are served through the existing /api/fs/media.
  if (req.method === "GET" && req.url === "/api/codex-themes") {
    (async () => {
      const root = path.join(os.homedir(), ".codexthemes", "themes");
      let dirs: fs.Dirent[] = [];
      try {
        dirs = (await fs.promises.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
      } catch {
        /* no ~/.codexthemes — an empty gallery, not an error */
      }
      const themes = [];
      for (const d of dirs) {
        try {
          const dir = path.join(root, d.name);
          const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, "theme.json"), "utf8"));
          const resolveAsset = (rel: unknown) => {
            if (typeof rel !== "string" || !rel) return null;
            const abs = path.join(dir, rel);
            return fs.existsSync(abs) ? abs : null;
          };
          const artPath = resolveAsset(manifest.art);
          // Prefer a shipped design preview (a full-app screenshot) for the card.
          let previewPath: string | null = null;
          try {
            const previews = await fs.promises.readdir(path.join(dir, "previews"));
            const img = previews.find((f) => /\.(png|jpe?g|webp|avif)$/i.test(f));
            if (img) previewPath = path.join(dir, "previews", img);
          } catch {
            /* no previews dir */
          }
          themes.push({ manifest, artPath, previewPath: previewPath ?? artPath });
        } catch {
          /* not a readable theme package — skip it */
        }
      }
      // `root` lets Appearance offer a "reveal in Finder" button without the
      // frontend having to guess the home directory.
      json(200, { themes, root });
    })().catch(fail);
    return;
  }

  // Per-agent CLI conversation history for the SideRail history browser.
  // Readers live in agentSessions.ts (claude, codex); unknown agents return
  // sessions: null so the frontend can show "not supported" instead of empty.
  if (req.method === "GET" && reqUrl.pathname === "/api/agent-sessions") {
    (async () => {
      const agent = reqUrl.searchParams.get("agent") ?? "claude";
      json(200, { sessions: await listAgentSessions(agent) });
    })().catch(fail);
    return;
  }

  // Daily per-agent/per-model token usage for the SideRail usage dashboard.
  // Which build this server came from. The desktop app probes this on launch to
  // decide whether an already-listening server is safe to reuse; keep it cheap
  // and dependency-free so it answers even if everything else is broken.
  if (req.method === "GET" && reqUrl.pathname === "/api/version") {
    json(200, { version: SERVER_VERSION });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/agent-usage") {
    (async () => {
      json(200, { rows: await listAgentUsage() });
    })().catch(fail);
    return;
  }

  // Whole-machine CPU/memory + top processes for the SideRail system monitor.
  if (req.method === "GET" && reqUrl.pathname === "/api/system-stats") {
    (async () => {
      json(200, await readSystemStats());
    })().catch(fail);
    return;
  }

  // Changed files (plus branch list) for the repo containing the focused pane's
  // cwd. With no `base` this is the working tree split into staged/unstaged/
  // untracked; with one it is "what this branch changes vs that branch",
  // measured from their merge base. Returns { repo: false } rather than an
  // error when the directory isn't in a repo — an empty state, not a failure.
  if (req.method === "GET" && reqUrl.pathname === "/api/git/overview") {
    (async () => {
      const cwd = await sessionCwd(reqUrl.searchParams.get("session") ?? "");
      json(200, await gitOverview(cwd, reqUrl.searchParams.get("base") ?? undefined));
    })().catch(fail);
    return;
  }

  // Unified diff for one file, fetched as its card is expanded. `section` says
  // which side it came from and so which diff to run.
  if (req.method === "GET" && reqUrl.pathname === "/api/git/diff") {
    (async () => {
      const cwd = await sessionCwd(reqUrl.searchParams.get("session") ?? "");
      const filePath = reqUrl.searchParams.get("path") ?? "";
      if (!filePath) return json(400, { error: "path is required" });
      const section = reqUrl.searchParams.get("section") ?? "unstaged";
      json(
        200,
        await gitDiff({
          cwd,
          path: filePath,
          oldPath: reqUrl.searchParams.get("oldPath") ?? undefined,
          section: section as "staged" | "unstaged" | "untracked" | "changed",
          base: reqUrl.searchParams.get("base") ?? undefined,
        })
      );
    })().catch(fail);
    return;
  }

  // AI theme generation — uses the configured default model.
  if (req.method === "POST" && req.url === "/api/theme") {
    readJson(req)
      .then(async (body) => {
        const prompt = String(body.prompt ?? "").trim();
        if (!prompt) return json(400, { error: "prompt is required" });
        json(200, await generateTheme(prompt));
      })
      .catch(fail);
    return;
  }

  // Clipboard image paste support. The browser cannot write directly to the
  // local filesystem, so the local server persists the blob and returns a path
  // that can be inserted into the active terminal prompt.
  if (req.method === "POST" && reqUrl.pathname === "/api/paste-image") {
    const contentType = normalizeImageType(
      reqUrl.searchParams.get("type") ||
        String(req.headers["content-type"] ?? "").split(";")[0] ||
        "image/png"
    );
    readBuffer(req)
      .then(async (body) => {
        if (contentType === "application/json") {
          json(200, await savePastedImage(JSON.parse(body.toString("utf8") || "{}")));
          return;
        }
        json(200, await writePastedImage(contentType, body));
      })
      .catch(fail);
    return;
  }

  res.writeHead(404).end();
});

// A stale server (e.g. one this app is about to replace after a self-update)
// may not have released the port yet by the time we try to bind it — retry
// briefly before giving up, so the race doesn't fail the whole launch.
const LISTEN_RETRY_MS = 300;
const LISTEN_RETRY_ATTEMPTS = 5;
let listenAttempts = 0;

function tryListen(): void {
  listenAttempts++;
  http.listen(PORT, () => {
    console.log(`[termany] PTY server listening on ws://localhost:${PORT}  (shell: ${SHELL})`);
    warmAgentSessionCache();
  });
}

http.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    if (listenAttempts < LISTEN_RETRY_ATTEMPTS) {
      setTimeout(tryListen, LISTEN_RETRY_MS);
      return;
    }
    console.error(
      `[termany] port ${PORT} is already in use — another Termany server is ` +
        `probably running. Stop it (pkill -f "code/termany") and retry.`
    );
    process.exit(1);
  }
  throw err;
});

const wss = new WebSocketServer({ server: http });

let connCount = 0;

async function cwdForPid(pid: number): Promise<string | undefined> {
  try {
    if (os.platform() === "linux") return await fs.promises.realpath(`/proc/${pid}/cwd`);
    if (os.platform() === "darwin") {
      const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], {
        timeout: 1000,
        maxBuffer: 4096,
      });
      const line = stdout
        .split("\n")
        .find((value) => value.startsWith("n") && value.length > 1);
      return line?.slice(1);
    }
  } catch {
    return undefined;
  }
  return oscCwdByPid.get(pid);
}

/** Return `dir` if it's an existing directory, else undefined. */
async function dirIfValid(dir: string | undefined): Promise<string | undefined> {
  if (!dir) return undefined;
  try {
    return (await fs.promises.stat(dir)).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directory a pane is "in" right now: its shell's live cwd, else the last
 * one persisted for it by the sweep, else home. Anchors the endpoints that act
 * on whatever the focused terminal is currently looking at.
 */
async function sessionCwd(sessionId: string): Promise<string> {
  const pty = ptySessions.get(sessionId)?.pty;
  return (
    (await dirIfValid(pty ? await cwdForPid(pty.pid) : undefined)) ??
    (await dirIfValid(getSessionCwd(sessionId) ?? undefined)) ??
    os.homedir()
  );
}

/**
 * Where to start a new shell. A split inherits its sibling's live cwd
 * (`cwdFrom`); otherwise a restored pane lands in its own last-known directory
 * (persisted by the periodic sweep); failing both, the home directory.
 */
async function resolveSpawnCwd(cwdFrom: string | null, sessionId: string | null): Promise<string> {
  const fallback = os.homedir() || process.env.USERPROFILE || process.env.HOME || process.cwd();
  if (cwdFrom) {
    const source = ptySessions.get(cwdFrom)?.pty;
    const live = await dirIfValid(source ? await cwdForPid(source.pid) : undefined);
    if (live) return live;
  }
  if (sessionId) {
    const saved = await dirIfValid(getSessionCwd(sessionId) ?? undefined);
    if (saved) return saved;
  }
  return fallback;
}

/**
 * Record every live session's working directory so a respawned shell can return
 * to it after the app is closed and reopened. Runs on an interval (the app may
 * be SIGKILLed on quit, so we can't rely on a shutdown hook) and once at exit.
 */
async function sweepCwds(): Promise<void> {
  for (const [id, session] of ptySessions) {
    const cwd = await dirIfValid(await cwdForPid(session.pty.pid));
    if (cwd) {
      try {
        setSessionCwd(id, cwd);
      } catch {
        /* DB busy — next sweep will catch it */
      }
    }
  }
}

setInterval(() => {
  void sweepCwds();
}, 5000).unref();

wss.on("connection", async (ws: WebSocket, req) => {
  const cid = ++connCount;
  // Disable Nagle's algorithm: without this, TCP coalesces small writes with a
  // ~40ms delay, which makes interactive terminal output feel sluggish/laggy.
  (ws as unknown as { _socket?: { setNoDelay: (enabled: boolean) => void } })._socket?.setNoDelay(true);

  const url = new URL(req.url ?? "/", "ws://localhost");
  const sessionId = url.searchParams.get("session");

  // --- Reattach: the session's shell is still running (detached or stolen
  // from a stale connection) — resume it instead of spawning a fresh one.
  const existing = sessionId ? ptySessions.get(sessionId) : undefined;
  if (existing) {
    console.log(`[termany] client #${cid} reattached to session ${sessionId} (pid ${existing.pty.pid})`);
    if (existing.ws && existing.ws !== ws) {
      try {
        existing.ws.close();
      } catch {
        /* already closing */
      }
    }
    existing.ws = ws;
    existing.detachedAt = null;

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "input") existing.pty.write(msg.data);
      else if (msg.type === "resize") {
        try {
          existing.pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
        } catch {
          /* race during teardown */
        }
      }
    });
    ws.on("close", () => {
      if (existing.ws !== ws) return; // a newer connection already replaced us
      existing.ws = null;
      existing.detachedAt = Date.now();
      if (existing.ring.dirty) {
        try {
          setScrollBatch({ [sessionId!]: existing.ring.chunks.join("") });
        } catch {
          /* the 10s flush already saved most of it */
        }
      }
    });
    return;
  }

  console.log(`[termany] client #${cid} connected`);
  const pendingMessages: ClientMessage[] = [];

  let session: PtySession | undefined;
  let closed = false;
  const applyClientMessage = (msg: ClientMessage) => {
    if (!session) {
      pendingMessages.push(msg);
      return;
    }
    if (msg.type === "input") {
      session.pty.write(msg.data);
    } else if (msg.type === "resize") {
      try {
        session.pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
      } catch {
        /* race during teardown */
      }
    }
  };

  // Client -> PTY (JSON control frames). Messages can arrive while cwd lookup is
  // still in flight, so buffer them until the PTY has been spawned.
  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    applyClientMessage(msg);
  });

  ws.on("close", () => {
    closed = true;
    if (!session) return;
    if (!sessionId) {
      // No session id to reattach by — kill immediately, as always.
      ephemeralSessions.delete(session);
      try {
        session.pty.kill();
      } catch {
        /* already gone */
      }
      return;
    }
    // Detach: leave the shell running so a reconnect can resume it. Guard
    // against the window-reload race, where a newer connection may already
    // have taken over this session.
    if (session.ws !== ws) return;
    session.ws = null;
    session.detachedAt = Date.now();
    if (session.ring.dirty) {
      try {
        setScrollBatch({ [sessionId]: session.ring.chunks.join("") });
      } catch {
        /* the 10s flush already saved most of it */
      }
    }
  });

  const cwd = await resolveSpawnCwd(url.searchParams.get("cwdFrom"), sessionId);
  if (closed) return;

  let pty: ReturnType<typeof spawn>;
  try {
    pty = spawn(SHELL, SHELL_ARGS, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });
  } catch (err) {
    // Never let one bad spawn take down the whole server.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[termany] failed to spawn shell:", msg);
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[31m[termany] failed to spawn shell: ${msg}\x1b[0m\r\n`);
      ws.close();
    }
    return;
  }

  session = { pty, ring: sessionId ? newRing(sessionId) : { chunks: [], bytes: 0, dirty: false }, ws, detachedAt: null };
  if (sessionId) ptySessions.set(sessionId, session);
  else ephemeralSessions.add(session);
  wireSession(sessionId ?? undefined, session);

  pendingMessages.splice(0).forEach(applyClientMessage);
});

// Kill every spawned shell when the server process itself is stopped (dev
// Ctrl-C, an explicit `stop_server` before a self-update relaunch — see the
// desktop side). An ordinary window/app close does NOT reach here: this
// process is meant to keep running with its shells attached-or-detached so a
// reopened app resumes them, rather than losing them like a plain restart.
async function shutdown() {
  // Best-effort: capture the final working directories before the shells die, so
  // a clean quit restores them exactly. Bounded so we never hang the exit.
  await Promise.race([sweepCwds(), new Promise((r) => setTimeout(r, 800))]).catch(() => {});
  flushScroll();
  for (const session of ptySessions.values()) {
    try {
      session.pty.kill();
    } catch {
      /* already gone */
    }
  }
  for (const session of ephemeralSessions) {
    try {
      session.pty.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

tryListen();
