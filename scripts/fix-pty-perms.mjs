// node-pty's prebuilt `spawn-helper` (macOS/Linux) sometimes ships without the
// execute bit, which makes posix_spawn fail at runtime ("posix_spawnp failed").
// Restore +x after every install. No-op on Windows / if not present.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeModules = join(root, "node_modules");
const prebuildDirs = [join(nodeModules, "node-pty", "prebuilds")];
const pnpmStore = join(nodeModules, ".pnpm");

if (existsSync(pnpmStore)) {
  for (const entry of readdirSync(pnpmStore)) {
    if (entry.startsWith("node-pty@")) {
      prebuildDirs.push(join(pnpmStore, entry, "node_modules", "node-pty", "prebuilds"));
    }
  }
}

for (const prebuilds of prebuildDirs) {
  if (!existsSync(prebuilds)) continue;
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, "spawn-helper");
    if (existsSync(helper)) {
      chmodSync(helper, 0o755);
      console.log(`[termany] chmod +x ${helper}`);
    }
  }
}
