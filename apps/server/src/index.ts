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
import { promisify } from "node:util";
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

/**
 * The PTY server. One WebSocket connection == one shell session.
 *
 * Today it runs locally and spawns a shell on this machine. The SAME server,
 * moved behind auth + a container-per-session sandbox, becomes the cloud
 * backend — the web frontend doesn't change a line. That's the whole point of
 * keeping the PTY behind WebSocketBackend.
 */

const PORT = Number(process.env.TERMANY_PORT ?? 5174);
const IS_WIN = os.platform() === "win32";
const PASTE_DIR = process.env.TERMANY_PASTE_DIR ?? `${os.tmpdir()}/termany-pastes`;
// Launch a LOGIN shell so it runs /etc/zprofile + ~/.zprofile (Homebrew's
// `brew shellenv`, fnm/pyenv/etc.) — a GUI app inherits only a minimal PATH,
// so without this the user's profile hits "command not found".
const execFileAsync = promisify(execFile);

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
const SHELL_ARGS = IS_WIN ? ["-NoLogo"] : ["-l"];

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

// --- scroll history ---------------------------------------------------------
// The server tails every session's raw PTY output into a per-session ring
// (Wave-style: history survives restarts without the frontend serializing
// anything). Memory: only sessions connected this run hold a ring, each capped
// at SCROLL_CAP bytes. Disk: dirty rings flush to SQLite every 10s, on session
// close, and on a pagehide beacon from the frontend (the app may SIGKILL us on
// quit, so the timed flush alone isn't enough).

const SCROLL_CAP = 512 * 1024; // raw bytes/session ≈ a few thousand visible lines

interface ScrollRing {
  chunks: string[];
  bytes: number;
  dirty: boolean;
}

const scrollRings = new Map<string, ScrollRing>();

/** The session's ring, seeded from its saved history so runs concatenate. */
function ringFor(sessionId: string): ScrollRing {
  let ring = scrollRings.get(sessionId);
  if (!ring) {
    const saved = getScroll(sessionId) ?? "";
    ring = {
      chunks: saved ? [saved] : [],
      bytes: Buffer.byteLength(saved),
      dirty: false,
    };
    scrollRings.set(sessionId, ring);
  }
  return ring;
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

/** Persist every dirty ring; coalesces each into one string as a side effect. */
function flushScroll(): void {
  const batch: Record<string, string> = {};
  for (const [id, ring] of scrollRings) {
    if (!ring.dirty) continue;
    const data = ring.chunks.join("");
    ring.chunks = [data]; // coalesce: fewer live string objects between flushes
    ring.dirty = false;
    batch[id] = data;
  }
  try {
    setScrollBatch(batch);
  } catch (err) {
    console.error("[termany] scroll flush failed:", err);
  }
}

setInterval(flushScroll, 10_000).unref();

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

  // Terminal scroll history — the server tails each session's raw PTY output
  // (see the ring machinery above), so restore is one sanitized read. Sessions
  // that quit inside a TUI's alternate screen get their captured final screen
  // appended AFTER leaving the alt screen, so it survives as plain history
  // (the alt screen itself is discarded on replay, by terminal semantics).
  if (req.method === "GET" && req.url === "/api/scroll") {
    const merged = getAllScroll();
    for (const [id, ring] of scrollRings) merged[id] = ring.chunks.join("");
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
  // Permanently drop restore data (cwd + scroll history) for closed panes.
  if (req.method === "POST" && req.url === "/api/forget") {
    readJson(req)
      .then((body) => {
        const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
        forgetSessions(ids);
        for (const id of ids) scrollRings.delete(id);
        json(200, { ok: true });
      })
      .catch(fail);
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
  const reqUrl = new URL(req.url ?? "/", "http://localhost");
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

http.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
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
const livePtys = new Set<ReturnType<typeof spawn>>();
const ptysBySession = new Map<string, ReturnType<typeof spawn>>();

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
  return undefined;
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
 * Where to start a new shell. A split inherits its sibling's live cwd
 * (`cwdFrom`); otherwise a restored pane lands in its own last-known directory
 * (persisted by the periodic sweep); failing both, the home directory.
 */
async function resolveSpawnCwd(cwdFrom: string | null, sessionId: string | null): Promise<string> {
  const fallback = os.homedir() || process.env.USERPROFILE || process.env.HOME || process.cwd();
  if (cwdFrom) {
    const source = ptysBySession.get(cwdFrom);
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
  for (const [id, pty] of ptysBySession) {
    const cwd = await dirIfValid(await cwdForPid(pty.pid));
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
  console.log(`[termany] client #${cid} connected`);
  // Disable Nagle's algorithm: without this, TCP coalesces small writes with a
  // ~40ms delay, which makes interactive terminal output feel sluggish/laggy.
  (ws as unknown as { _socket?: { setNoDelay: (enabled: boolean) => void } })._socket?.setNoDelay(true);

  const url = new URL(req.url ?? "/", "ws://localhost");
  const sessionId = url.searchParams.get("session");
  const pendingMessages: ClientMessage[] = [];

  let pty: ReturnType<typeof spawn> | undefined;
  let closed = false;
  const applyClientMessage = (msg: ClientMessage) => {
    if (!pty) {
      pendingMessages.push(msg);
      return;
    }
    if (msg.type === "input") {
      pty.write(msg.data);
    } else if (msg.type === "resize") {
      try {
        pty.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
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
    // Persist and release this session's history ring — unless a newer
    // connection has already adopted the session (window reload race).
    if (sessionId && (!pty || ptysBySession.get(sessionId) === pty)) {
      const ring = scrollRings.get(sessionId);
      if (ring) {
        if (ring.dirty) {
          try {
            setScrollBatch({ [sessionId]: ring.chunks.join("") });
          } catch {
            /* the 10s flush already saved most of it */
          }
        }
        scrollRings.delete(sessionId);
      }
    }
    if (!pty) return;
    livePtys.delete(pty);
    if (sessionId && ptysBySession.get(sessionId) === pty) ptysBySession.delete(sessionId);
    try {
      pty.kill();
    } catch {
      /* already gone */
    }
  });

  const cwd = await resolveSpawnCwd(url.searchParams.get("cwdFrom"), sessionId);
  if (closed) return;

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

  livePtys.add(pty);
  if (sessionId) ptysBySession.set(sessionId, pty);
  // Acquired AFTER registering the pty, so the reload race in ws.on("close")
  // above can never delete a ring this connection is still appending to.
  const ring = sessionId ? ringFor(sessionId) : undefined;

  // PTY output -> client (raw text frames) + the session's history ring
  const onData = pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
    if (ring) ringAppend(ring, data);
  });

  const onExit = pty.onExit(({ exitCode, signal }) => {
    livePtys.delete(pty);
    if (sessionId && ptysBySession.get(sessionId) === pty) ptysBySession.delete(sessionId);
    console.error(
      `[termany] shell exited (pid: ${pty.pid}, code: ${exitCode}, signal: ${signal ?? "none"})`
    );
    if (ws.readyState === ws.OPEN) {
      ws.send(
        `\r\n\x1b[2m[termany] shell exited (code: ${exitCode}, signal: ${signal ?? "none"})\x1b[0m\r\n`
      );
    }
    if (ws.readyState === ws.OPEN) ws.close();
  });

  pendingMessages.splice(0).forEach(applyClientMessage);

  ws.on("close", () => {
    onData.dispose();
    onExit.dispose();
  });
});

// Kill every spawned shell when the server is stopped, so dev restarts don't
// leave a pile of orphaned interactive shells behind.
async function shutdown() {
  // Best-effort: capture the final working directories before the shells die, so
  // a clean quit restores them exactly. Bounded so we never hang the exit.
  await Promise.race([sweepCwds(), new Promise((r) => setTimeout(r, 800))]).catch(() => {});
  flushScroll();
  for (const pty of livePtys) {
    try {
      pty.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

http.listen(PORT, () => {
  console.log(`[termany] PTY server listening on ws://localhost:${PORT}  (shell: ${SHELL})`);
});
