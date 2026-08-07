import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gitOverview } from "../src/git.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repo with one commit and one linked worktree, in a fresh temp dir. */
function makeRepo() {
  // realpathSync.native: os.tmpdir() may return a short (8.3) path on
  // Windows, while git's --show-toplevel reports the long form the tests
  // compare against.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "termany-git-test-")));
  const main = path.join(dir, "main");
  const linked = path.join(dir, "linked");
  fs.mkdirSync(main);
  git(["init", "-q"], main);
  git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "init"], main);
  git(["worktree", "add", "-q", linked, "-b", "feat"], main);
  return { dir, main, linked };
}

test("a worktree whose directory was renamed away is not offered as a target", async () => {
  const { dir, main, linked } = makeRepo();
  try {
    // Rename the worktree directory (e.g. fixing a typo in its name). Git
    // keeps the OLD path registered, marked prunable, until `worktree prune`.
    fs.renameSync(linked, linked + "-renamed");
    const overview = await gitOverview(main);
    assert.equal(overview.repo, true);
    if (!overview.repo) return;
    assert.equal(overview.root, path.resolve(main));
    // The ghost path must not appear in the switcher. (The worktrees field
    // itself is omitted once only one real worktree remains — the switcher
    // is only shipped when there is something to switch between.)
    assert.equal((overview.worktrees ?? []).some((w) => w.path === path.resolve(linked)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("selecting a stale worktree falls back to the terminal's repo instead of 500ing", async () => {
  const { dir, main, linked } = makeRepo();
  try {
    fs.renameSync(linked, linked + "-renamed");
    // The client can still SEND the stale path (a selection made before the
    // rename, or an older panel's cache). Spawning git with that cwd is what
    // used to reject with "spawn git ENOENT" and fail the whole request.
    const overview = await gitOverview(main, { worktree: linked });
    assert.equal(overview.repo, true);
    if (!overview.repo) return;
    assert.equal(overview.root, path.resolve(main));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
