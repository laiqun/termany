import assert from "node:assert/strict";
import test from "node:test";
import { parseListeningPorts, parseProcessParents, portsUnderPid } from "./sessionPorts.js";

const LSOF = [
  "COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
  "node      92310  benn   23u  IPv6 0xabc            0t0  TCP *:3035 (LISTEN)",
  "node      92310  benn   24u  IPv4 0xdef            0t0  TCP 127.0.0.1:3035 (LISTEN)",
  "node      92311  benn   19u  IPv4 0x123            0t0  TCP 127.0.0.1:4000 (LISTEN)",
  "postgres    701  benn    7u  IPv4 0x456            0t0  TCP 127.0.0.1:5432 (LISTEN)",
  "",
].join("\n");

// zsh(500) → npm(9000) → vite(92310); a second pane's shell is 600.
const PS = ["  500     1", " 9000   500", " 92310  9000", " 92311   600", "   600     1", "   701     1"].join(
  "\n"
);

test("dedupes the IPv4 and IPv6 rows of one bound port", () => {
  assert.deepEqual(parseListeningPorts(LSOF).get(92310), [3035]);
});

test("skips the lsof header", () => {
  assert.equal(parseListeningPorts(LSOF).has(NaN), false);
  assert.equal(parseListeningPorts(LSOF).size, 3);
});

test("finds a port opened by a grandchild of the pane's shell", () => {
  const probe = { portsByPid: parseListeningPorts(LSOF), parents: parseProcessParents(PS) };
  assert.deepEqual(portsUnderPid(500, probe), [3035]);
});

test("does not claim another pane's port", () => {
  const probe = { portsByPid: parseListeningPorts(LSOF), parents: parseProcessParents(PS) };
  assert.deepEqual(portsUnderPid(600, probe), [4000]);
});

test("ignores unrelated system daemons", () => {
  const probe = { portsByPid: parseListeningPorts(LSOF), parents: parseProcessParents(PS) };
  assert.deepEqual(portsUnderPid(1, probe), [3035, 4000, 5432]); // pid 1 IS everyone's ancestor
  assert.deepEqual(portsUnderPid(9000, probe), [3035]);
});

test("reports the shell's own ports", () => {
  const probe = {
    portsByPid: parseListeningPorts("ssh 500 benn 5u IPv4 0x1 0t0 TCP 127.0.0.1:8022 (LISTEN)"),
    parents: parseProcessParents(PS),
  };
  assert.deepEqual(portsUnderPid(500, probe), [8022]);
});

test("survives a cyclic parent table", () => {
  const probe = {
    portsByPid: new Map([[10, [3000]]]),
    parents: new Map([
      [10, 11],
      [11, 10],
    ]),
  };
  assert.deepEqual(portsUnderPid(999, probe), []);
});
