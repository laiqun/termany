import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { resolveExecutable } from "./shellPath.js";

const HAS_ZSH = process.platform !== "win32" && fs.existsSync("/bin/zsh");

describe("resolveExecutable", { skip: HAS_ZSH ? false : "needs /bin/zsh" }, () => {
  let dir = "";
  let binDir = "";
  const originalShell = process.env.SHELL;
  const originalZdotdir = process.env.ZDOTDIR;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "termany-shellpath-"));
    binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "termany-fixture"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Exactly how opencode, pnpm and nvm install themselves: a PATH export in
    // .zshrc, which a NON-interactive `zsh -lc` never reads.
    fs.writeFileSync(path.join(dir, ".zshrc"), `export PATH="${binDir}:$PATH"\n`);
    fs.writeFileSync(path.join(dir, ".zprofile"), "");
    process.env.SHELL = "/bin/zsh";
    process.env.ZDOTDIR = dir;
  });

  after(() => {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    if (originalZdotdir === undefined) delete process.env.ZDOTDIR;
    else process.env.ZDOTDIR = originalZdotdir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("finds a command only ~/.zshrc puts on PATH", async () => {
    assert.equal(await resolveExecutable("termany-fixture"), path.join(binDir, "termany-fixture"));
  });

  test("ignores rc-file chatter on stdout", async () => {
    fs.writeFileSync(
      path.join(dir, ".zshrc"),
      `echo "welcome banner"\nexport PATH="${binDir}:$PATH"\n`
    );
    assert.equal(await resolveExecutable("termany-fixture"), path.join(binDir, "termany-fixture"));
  });

  test("returns undefined for a missing command", async () => {
    assert.equal(await resolveExecutable("termany-does-not-exist"), undefined);
  });

  test("accepts an explicit executable path", async () => {
    assert.equal(
      await resolveExecutable(path.join(binDir, "termany-fixture")),
      path.join(binDir, "termany-fixture")
    );
  });

  test("rejects an explicit path that is not executable", async () => {
    const plain = path.join(dir, "not-executable");
    fs.writeFileSync(plain, "", { mode: 0o644 });
    assert.equal(await resolveExecutable(plain), undefined);
  });
});
