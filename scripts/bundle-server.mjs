// Assemble the Node PTY/API server into the Tauri app's resources so a packaged
// build can launch it (see apps/desktop/src-tauri/src/lib.rs). Produces:
//
//   apps/desktop/src-tauri/resources/server/
//     ├─ node                      (bundled Node runtime, darwin-arm64)
//     ├─ server.cjs                (the server, bundled; node-pty left external)
//     └─ node_modules/node-pty/…   (native addon + prebuilds/spawn-helper)
//
// CI signs `node` (with entitlements) and the native binaries after this runs.
// Run from the repo root: `node scripts/bundle-server.mjs`.

import { execSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "22.11.0";
const TRIPLE = "darwin-arm64"; // macOS arm64 only, for now

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "apps/desktop/src-tauri/resources/server");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit", shell: "/bin/bash" });

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

// 2. Ship node-pty next to the bundle, and restore the spawn-helper exec bit
//    (cpSync preserves mode, but be defensive).
const ptySrc = path.join(root, "node_modules/node-pty");
const ptyDst = path.join(out, "node_modules/node-pty");
cpSync(ptySrc, ptyDst, { recursive: true });
const prebuilds = path.join(ptyDst, "prebuilds");
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    // Keep only the target's prebuild — other arches' native files (esp. the
    // Windows PE .node files) would break codesign in CI, and just add bloat.
    if (platform !== TRIPLE) {
      rmSync(path.join(prebuilds, platform), { recursive: true, force: true });
      continue;
    }
    const helper = path.join(prebuilds, platform, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

// 3. Bundled Node runtime for the target.
run(
  `curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${TRIPLE}.tar.gz ` +
    `| tar xz --strip-components=2 -C "${out}" "node-v${NODE_VERSION}-${TRIPLE}/bin/node"`
);
chmodSync(path.join(out, "node"), 0o755);

console.log(`[termany] server bundle assembled at ${out}`);
