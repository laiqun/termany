// Assemble the Node PTY/API server into the Tauri app's resources so a packaged
// build can launch it (see apps/desktop/src-tauri/src/lib.rs). Produces:
//
//   apps/desktop/src-tauri/resources/server/
//     ├─ node (or node.exe)        (bundled Node runtime for the host platform)
//     ├─ server.cjs                (the server, bundled; node-pty left external)
//     └─ node_modules/node-pty/…   (native addon + prebuilds for the host)
//
// Platform-aware: bundles for whatever platform/arch this script runs on, so
// the macOS CI produces a darwin-arm64 bundle and the Windows CI a win32-x64
// one. On macOS, CI signs `node` (with entitlements) and the native binaries
// after this runs. Run from the repo root: `node scripts/bundle-server.mjs`.

import { execSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node 24: matches the dev runtime and supports node:sqlite without a flag
// (v22 doesn't ship node:sqlite at all). Keep in sync with the dev Node major.
const NODE_VERSION = "24.0.0";

const PLATFORM = process.platform; // 'darwin' | 'win32' | 'linux'
const ARCH = process.arch; // 'arm64' | 'x64'
const IS_WIN = PLATFORM === "win32";

// node-pty stores prebuilds under `prebuilds/<platform>-<arch>` (matching
// process.platform + '-' + process.arch), e.g. darwin-arm64 / win32-x64.
const PTY_TRIPLE = `${PLATFORM}-${ARCH}`;
// nodejs.org dist naming: win-x64 / darwin-arm64 / linux-x64.
const NODE_OS = IS_WIN ? "win" : PLATFORM;
const NODE_DIST = `node-v${NODE_VERSION}-${NODE_OS}-${ARCH}`;
const NODE_BIN = IS_WIN ? "node.exe" : "node";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "apps/desktop/src-tauri/resources/server");
// Force bash on unix (the curl|tar pipe needs it); on Windows let execSync use
// the default ComSpec (cmd.exe) — curl and tar ship with Windows 10+.
const run = (cmd) =>
  execSync(cmd, { cwd: root, stdio: "inherit", ...(IS_WIN ? {} : { shell: "/bin/bash" }) });

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "node_modules"), { recursive: true });

// 1. Bundle the server to a single CJS file. node-pty is native, so it stays
//    external and is shipped separately; everything else (ws, the Anthropic
//    SDK, @termany/core) is inlined.
run(
  `npx --no-install esbuild apps/server/src/index.ts --bundle --platform=node ` +
    `--format=cjs --target=node22 --external:node-pty ` +
    `--outfile="${path.join(out, "server.cjs")}"`
);

// 2. Ship node-pty next to the bundle. Keep only the host's prebuild (other
//    arches' native files just add bloat and, on macOS, break codesign), and
//    drop the .pdb debug symbols the Windows prebuilds carry (~40MB).
const ptySrc = path.join(root, "node_modules/node-pty");
const ptyDst = path.join(out, "node_modules/node-pty");
cpSync(ptySrc, ptyDst, { recursive: true });
const prebuilds = path.join(ptyDst, "prebuilds");
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    if (platform !== PTY_TRIPLE) {
      rmSync(path.join(prebuilds, platform), { recursive: true, force: true });
      continue;
    }
    const dir = path.join(prebuilds, platform);
    stripPdbs(dir);
    // Restore the unix spawn-helper exec bit (cpSync preserves mode, but be
    // defensive); it doesn't exist on Windows.
    const helper = path.join(dir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

// 3. Bundled Node runtime for the host platform.
if (IS_WIN) {
  const zip = path.join(out, "node.zip");
  run(`curl -fsSL -o "${zip}" https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.zip`);
  // bsdtar (shipped with Windows 10+) extracts .zip and honours --strip-components.
  run(`tar -xf "${zip}" --strip-components=1 -C "${out}" "${NODE_DIST}/node.exe"`);
  rmSync(zip, { force: true });
} else {
  run(
    `curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.gz ` +
      `| tar xz --strip-components=2 -C "${out}" "${NODE_DIST}/bin/node"`
  );
  chmodSync(path.join(out, NODE_BIN), 0o755);
}

console.log(`[termany] server bundle assembled at ${out} (${PTY_TRIPLE}, ${NODE_BIN})`);

/** Remove *.pdb debug symbols recursively (only present in Windows prebuilds). */
function stripPdbs(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) stripPdbs(p);
    else if (name.name.endsWith(".pdb")) rmSync(p, { force: true });
  }
}
