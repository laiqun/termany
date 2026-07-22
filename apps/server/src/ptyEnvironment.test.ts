import assert from "node:assert/strict";
import test from "node:test";
import { ptyEnvironment } from "./ptyEnvironment.js";

test("adds a UTF-8 character locale for a Finder-style empty macOS environment", () => {
  assert.deepEqual(ptyEnvironment({ HOME: "/Users/test" }, "darwin"), {
    HOME: "/Users/test",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "en_US.UTF-8",
  });
});

test("keeps an existing UTF-8 locale unchanged", () => {
  assert.deepEqual(ptyEnvironment({ LANG: "zh_CN.UTF-8" }, "darwin"), {
    LANG: "zh_CN.UTF-8",
    TERM: "xterm-256color",
  });
});

test("replaces a non-UTF-8 LC_ALL without changing other locale categories", () => {
  assert.deepEqual(
    ptyEnvironment({ LANG: "zh_CN.GB18030", LC_ALL: "C", LC_TIME: "zh_CN.GB18030" }, "darwin"),
    {
      LANG: "zh_CN.GB18030",
      LC_CTYPE: "en_US.UTF-8",
      LC_TIME: "zh_CN.GB18030",
      TERM: "xterm-256color",
    }
  );
});

test("does not alter locale variables on Windows", () => {
  assert.deepEqual(ptyEnvironment({ LANG: "C" }, "win32"), {
    LANG: "C",
    TERM: "xterm-256color",
  });
});
