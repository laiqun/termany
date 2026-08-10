import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addWorktree, gitOverview, removeWorktree } from "../src/git.ts";

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

test("addWorktree creates a linked worktree on a new branch", async () => {
  const { dir, main } = makeRepo();
  try {
    const created = await addWorktree(main, "topic", undefined);
    assert.ok(fs.existsSync(created.path));
    const overview = await gitOverview(main);
    assert.equal(overview.repo, true);
    if (!overview.repo) return;
    const entry = (overview.worktrees ?? []).find((w) => w.path === created.path);
    assert.ok(entry, "the new worktree should appear in the switcher");
    assert.equal(entry.branch, "topic");
    assert.equal(entry.main, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("addWorktree refuses a branch name that already exists", async () => {
  const { dir, main } = makeRepo();
  try {
    await assert.rejects(() => addWorktree(main, "feat", undefined), /already exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("addWorktree with a todo writes TODO.txt and hides it from git status", async () => {
  const { dir, main } = makeRepo();
  try {
    const created = await addWorktree(main, "todo-topic", undefined, { todo: "Ship the thing\n" });
    assert.equal(fs.readFileSync(path.join(created.path, "TODO.txt"), "utf8"), "Ship the thing\n");
    // The exclude entry lives in the shared git dir, so the note is not an
    // untracked file in ANY worktree of the repo.
    const commonDir = git(["rev-parse", "--git-common-dir"], main).trim();
    assert.ok(fs.readFileSync(path.join(main, commonDir, "info", "exclude"), "utf8").includes("TODO.txt"));
    assert.equal(git(["status", "--porcelain"], created.path), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("addWorktree runs the setup command in the new worktree and only warns on failure", async () => {
  const { dir, main } = makeRepo();
  try {
    const ok = await addWorktree(main, "cmd-ok", undefined, {
      command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('marker.txt','1')"`,
    });
    assert.equal(ok.warning, undefined);
    assert.equal(fs.readFileSync(path.join(ok.path, "marker.txt"), "utf8"), "1");

    // A failing command must not fail the creation — the worktree exists.
    const bad = await addWorktree(main, "cmd-bad", undefined, { command: "exit 3" });
    assert.ok(fs.existsSync(bad.path));
    assert.ok(bad.warning, "a failing setup command should come back as a warning");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeWorktree refuses the main checkout", async () => {
  const { dir, main } = makeRepo();
  try {
    await assert.rejects(() => removeWorktree(main, main), /main checkout/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removal discards a dirty worktree and keeps the branch", async () => {
  const { dir, main, linked } = makeRepo();
  try {
    fs.writeFileSync(path.join(linked, "dirty.txt"), "x");
    await removeWorktree(main, linked);
    assert.equal(fs.existsSync(linked), false);
    // The branch is kept unless the caller asks to take it along.
    assert.equal(git(["branch", "--list", "feat"], main).trim(), "feat");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removal takes modified, untracked, and ignored files with it", async () => {
  const { dir, main, linked } = makeRepo();
  try {
    // Every flavour of "unclean": a tracked change, a fresh untracked file,
    // and an ignored one (build output, node_modules).
    fs.writeFileSync(path.join(linked, "tracked.txt"), "base");
    git(["add", "tracked.txt"], linked);
    git(["-c", "user.email=test@test", "-c", "user.name=test", "commit", "-q", "-m", "tracked"], linked);
    fs.writeFileSync(path.join(linked, "tracked.txt"), "edited");
    fs.writeFileSync(path.join(linked, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(linked, "ignored.txt"), "x");
    await removeWorktree(main, linked);
    assert.equal(fs.existsSync(linked), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a worktree whose .git pointer went missing still removes", async () => {
  const { dir, main, linked } = makeRepo();
  try {
    // A scaffolding tool emptying the directory (or a dotfile cleanup) loses
    // the `.git` file. The move-aside + prune removal doesn't care about
    // the pointer at all — git's own `worktree remove` would refuse.
    fs.rmSync(path.join(linked, ".git"));
    await removeWorktree(main, linked);
    assert.equal(fs.existsSync(linked), false);
    assert.equal(git(["worktree", "list"], main).includes("linked"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the moved-aside directory is deleted in the background", async () => {
  const { dir, main, linked } = makeRepo();
  try {
    fs.mkdirSync(path.join(linked, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(linked, "node_modules", "pkg", "index.js"), "x");
    await removeWorktree(main, linked);
    assert.equal(fs.existsSync(linked), false);
    for (let i = 0; i < 20; i++) {
      if (!fs.readdirSync(dir).some((e) => e.startsWith(".termany-trash-"))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail("the moved-aside directory was never cleaned up");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeWorktree takes the worktree's branch with it when asked", async () => {
  const { dir, main, linked } = makeRepo();
  try {
    await removeWorktree(main, linked, true);
    assert.equal(fs.existsSync(linked), false);
    assert.equal(git(["branch", "--list", "feat"], main).trim(), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeWorktree withBranch on a detached worktree just skips the branch step", async () => {
  const { dir, main } = makeRepo();
  try {
    const ghost = path.join(dir, "ghost");
    git(["worktree", "add", "-q", "--detach", ghost], main);
    await removeWorktree(main, ghost, true);
    assert.equal(fs.existsSync(ghost), false);
    // Nothing was deleted but the worktree — the repo's branches are intact.
    // (--format keeps the "checked out elsewhere" "+" marker out of the output.)
    assert.equal(git(["branch", "--list", "feat", "--format", "%(refname:short)"], main).trim(), "feat");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeWorktree rejects a path that is not one of the repo's worktrees", async () => {
  const { dir, main } = makeRepo();
  try {
    await assert.rejects(() => removeWorktree(main, path.join(dir, "elsewhere")), /Not a worktree/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a worktree whose directory is held open is reported busy, then removes once released", async () => {
  const { dir, main, linked } = makeRepo();
  // A process with its cwd inside the worktree holds the directory open the
  // way a shell or editor does. The move-aside rename then fails — on every
  // platform the caller gets a "busy" error rather than a half-removed
  // worktree — and once the process is gone the removal succeeds.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { cwd: linked });
  try {
    await assert.rejects(() => removeWorktree(main, linked, true), /in use/);
    assert.ok(fs.existsSync(linked));
    holder.kill();
    await new Promise((resolve) => holder.once("exit", resolve));
    await removeWorktree(main, linked, true);
    assert.equal(git(["branch", "--list", "feat", "--format", "%(refname:short)"], main).trim(), "");
  } finally {
    holder.kill();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
