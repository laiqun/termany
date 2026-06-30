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
import { loadState, saveState } from "./db.js";
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
const SHELL = process.env.SHELL || (IS_WIN ? "powershell.exe" : "zsh");
const PASTE_DIR = process.env.TERMANY_PASTE_DIR ?? `${os.tmpdir()}/termany-pastes`;
// Launch a LOGIN shell so it runs /etc/zprofile + ~/.zprofile (Homebrew's
// `brew shellenv`, fnm/pyenv/etc.) — a GUI app inherits only a minimal PATH,
// so without this the user's profile hits "command not found".
const SHELL_ARGS = IS_WIN ? [] : ["-l"];
const execFileAsync = promisify(execFile);

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

async function savePastedImage(body: any): Promise<{ path: string }> {
  const mime = String(body.type ?? "").toLowerCase();
  const data = String(body.data ?? "");
  const ext = IMAGE_EXT_BY_MIME[mime];
  if (!ext) throw new Error("unsupported image type");
  if (!data) throw new Error("image data is required");

  await fs.promises.mkdir(PASTE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = `${PASTE_DIR}/paste-${stamp}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await fs.promises.writeFile(filePath, Buffer.from(data, "base64"));
  return { path: filePath };
}

// One HTTP server hosts both the WebSocket upgrade (PTY sessions) and a small
// JSON API (POST /api/theme — AI theme generation, key stays server-side).
const http = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
  if (req.method === "POST" && req.url === "/api/paste-image") {
    readJson(req, 30_000_000)
      .then(async (body) => {
        json(200, await savePastedImage(body));
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

async function resolveSpawnCwd(cwdFrom: string | null): Promise<string> {
  const fallback = process.env.HOME || process.cwd();
  if (!cwdFrom) return fallback;
  const source = ptysBySession.get(cwdFrom);
  const cwd = source ? await cwdForPid(source.pid) : undefined;
  if (!cwd) return fallback;
  try {
    const stat = await fs.promises.stat(cwd);
    return stat.isDirectory() ? cwd : fallback;
  } catch {
    return fallback;
  }
}

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
    if (!pty) return;
    livePtys.delete(pty);
    if (sessionId && ptysBySession.get(sessionId) === pty) ptysBySession.delete(sessionId);
    try {
      pty.kill();
    } catch {
      /* already gone */
    }
  });

  const cwd = await resolveSpawnCwd(url.searchParams.get("cwdFrom"));
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

  // PTY output -> client (raw text frames)
  const onData = pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  const onExit = pty.onExit(() => {
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
function shutdown() {
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
