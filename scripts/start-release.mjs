// Start a release-mode web deployment: build the frontend, then run the PTY
// backend and a static preview server for apps/web/dist, both bound to all
// interfaces (0.0.0.0) so other machines on the LAN can connect.
//
//   node scripts/start-release.mjs [--skip-build]
//
// Env knobs:
//   TERMANY_PORT  backend WS/API port     (default 5174)
//   TERMANY_HOST  backend bind address    (default 0.0.0.0 in this script)
//   WEB_PORT      static preview port     (default 8080)
//
// Note: the built frontend points its WS client at VITE_PTY_URL, falling back
// to ws://localhost:5174 (see apps/web/src/terminal/manager.ts). To serve
// other machines, build with VITE_PTY_URL set, e.g.:
//   VITE_PTY_URL=ws://192.168.1.10:5174 node scripts/start-release.mjs
//
// Security: the backend has no authentication — anyone who can reach the port
// gets a shell on this machine. Bind to a trusted network only.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipBuild = process.argv.includes("--skip-build");
const webPort = process.env.WEB_PORT ?? "8080";
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";

if (!skipBuild) {
  const build = spawnSync(npm, ["run", "build:web"], { cwd: root, stdio: "inherit", shell: isWin });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const children = [];
function run(name, args, extraEnv = {}) {
  // shell:true on Windows: Node ≥18.20.2 refuses to spawn .cmd directly (EINVAL).
  const child = spawn(npm, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    shell: isWin,
  });
  child.on("exit", (code) => {
    console.log(`[termany] ${name} exited (${code}); shutting down`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

function shutdown(code) {
  for (const c of children) {
    if (c.exitCode !== null || c.killed) continue;
    if (isWin) {
      // shell:true wraps npm in cmd.exe; kill the whole tree so the actual
      // server processes don't linger after Ctrl+C.
      spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      c.kill();
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Backend: npm_lifecycle_event is "start", so it picks the 5174 release port
// (see apps/server/src/index.ts). The server itself binds loopback by
// default; opt into LAN access for this child only via TERMANY_HOST.
run("backend", ["-w", "@termany/server", "run", "start"], { TERMANY_HOST: process.env.TERMANY_HOST ?? "0.0.0.0" });
// Frontend: vite preview serves apps/web/dist; --host binds 0.0.0.0.
run("web", ["-w", "@termany/web", "run", "preview", "--", "--host", "--port", webPort, "--strictPort"]);

console.log(`[termany] web UI on http://0.0.0.0:${webPort}  (backend ws port ${process.env.TERMANY_PORT ?? 5174})`);
