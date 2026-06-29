// node-pty's prebuilt `spawn-helper` (macOS/Linux) sometimes ships without the
// execute bit, which makes posix_spawn fail at runtime ("posix_spawnp failed").
// Restore +x after every install. No-op on Windows / if not present.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const prebuilds = join(root, "node_modules", "node-pty", "prebuilds");

if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, "spawn-helper");
    if (existsSync(helper)) {
      chmodSync(helper, 0o755);
      console.log(`[termany] chmod +x ${helper}`);
    }
  }
}
