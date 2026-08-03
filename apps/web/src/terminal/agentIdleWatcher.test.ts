import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import xtermPkg from "@xterm/headless";
import { AGENT_IDLE_QUIET_MS } from "./agentActivityPrompt";
import { AgentIdleWatcher } from "./agentIdleWatcher";

const { Terminal } = xtermPkg as unknown as { Terminal: any };

type Turn = {
  cols: number;
  rows: number;
  /** [milliseconds relative to the Enter keypress, base64 PTY bytes] */
  chunks: [number, string][];
};

const turn: Turn = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/claude-turn.json", import.meta.url)),
    "utf8",
  ),
);

type Report = { atMs: number; status: string; agentActive: boolean };

const TURN_ENDED_MS = turn.chunks[turn.chunks.length - 1][0];
const CLOCK_TICK_MS = 1_000;

/** What a status bar or right-hand prompt paints at a given moment. */
function clockRow(atMs: number): string {
  const seconds = Math.floor(atMs / 1000);
  const mm = String(Math.floor(seconds / 60) % 60).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `~/programs/termany                    14:${mm}:${ss}`;
}

/**
 * Replay the recorded session through xterm and the real watcher, arming one
 * virtual timeout exactly the way manager.ts arms its real one: it fires only
 * if no further screen lands before the deadline.
 *
 * `withClock` adds a row that repaints once a second and carries nothing but
 * the time, the way tmux and clock-bearing prompts do. It is appended below
 * the agent's own output, which is the hostile placement: every bottom-anchored
 * scan in agentActivityPrompt has to look past it.
 */
async function replay(quietMs: number, withClock = false): Promise<Report[]> {
  const term = new Terminal({ cols: turn.cols, rows: turn.rows, allowProposedApi: true });
  const watcher = new AgentIdleWatcher(quietMs);
  const reports: Report[] = [];

  // A clock keeps repainting after the agent stops, which is the whole point:
  // its ticks are what used to push the quiet window out forever.
  const events: { atMs: number; chunk?: string }[] = turn.chunks.map(
    ([atMs, base64]) => ({ atMs, chunk: base64 }),
  );
  if (withClock) {
    for (let t = 0; t <= TURN_ENDED_MS + 5 * CLOCK_TICK_MS; t += CLOCK_TICK_MS) {
      events.push({ atMs: t });
    }
    events.sort((a, b) => a.atMs - b.atMs || (a.chunk ? -1 : 1));
  }

  for (let i = 0; i < events.length; i++) {
    const { atMs, chunk } = events[i];
    if (chunk) {
      await new Promise<void>((resolve) =>
        term.write(Buffer.from(chunk, "base64"), () => resolve()),
      );
    }
    const buf = term.buffer.active;
    const start = Math.max(0, buf.viewportY);
    const lines: string[] = [];
    for (let y = start; y < Math.min(buf.length, start + term.rows); y++) {
      lines.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    if (withClock) lines.push(clockRow(atMs));
    watcher.update(
      {
        visible: lines.join("\n"),
        cursorLine:
          buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true).trimEnd() ?? "",
        isAlternate: buf.type === "alternate",
      },
      atMs,
    );

    const deadline = watcher.deadline;
    const nextEventAt = events[i + 1]?.atMs ?? Infinity;
    if (deadline !== null && deadline <= nextEventAt) {
      const pending = watcher.pending!;
      reports.push({ atMs: deadline, ...pending });
    }
  }
  return reports;
}

test("replaying a real turn never finishes it while the agent is still working", async () => {
  const reports = await replay(AGENT_IDLE_QUIET_MS);
  const premature = reports.filter((r) => r.atMs > 0 && r.atMs < TURN_ENDED_MS);
  assert.deepEqual(
    premature,
    [],
    `reported completion ${premature.length} time(s) mid-turn, first at ${premature[0]?.atMs}ms of ${TURN_ENDED_MS}ms`,
  );
});

test("replaying a real turn does finish it once the screen settles", async () => {
  const reports = await replay(AGENT_IDLE_QUIET_MS);
  const final = reports.filter((r) => r.atMs >= TURN_ENDED_MS);
  assert.ok(final.length > 0, "never reported the finished turn");
  assert.equal(final[0].status, "done");
  assert.equal(final[0].agentActive, true, "Claude Code stays open at its composer");
  assert.ok(
    final[0].atMs - TURN_ENDED_MS <= AGENT_IDLE_QUIET_MS + 50,
    `took ${final[0].atMs - TURN_ENDED_MS}ms to settle`,
  );
});

test("a clock ticking beside the agent does not hold the turn open", async () => {
  // The regression this guards: the watcher used to restart its wait on every
  // PTY write, so one repainting clock row meant the dot never went green.
  const reports = await replay(AGENT_IDLE_QUIET_MS, true);
  const final = reports.filter((r) => r.atMs >= TURN_ENDED_MS);
  assert.ok(final.length > 0, "the clock kept the turn from ever finishing");
  assert.equal(final[0].status, "done");
  assert.equal(final[0].agentActive, true);
  assert.ok(
    final[0].atMs - TURN_ENDED_MS <= AGENT_IDLE_QUIET_MS + CLOCK_TICK_MS,
    `took ${final[0].atMs - TURN_ENDED_MS}ms to settle`,
  );
});

test("a clock does not finish a turn early either", async () => {
  const reports = await replay(AGENT_IDLE_QUIET_MS, true);
  const premature = reports.filter((r) => r.atMs > 0 && r.atMs < TURN_ENDED_MS);
  assert.deepEqual(
    premature,
    [],
    `reported completion ${premature.length} time(s) mid-turn, first at ${premature[0]?.atMs}ms of ${TURN_ENDED_MS}ms`,
  );
});

test("the previous 200ms window is what let turns finish early", async () => {
  // Anchors the regression: the bug was the threshold, not the screen reading.
  const premature = (await replay(200)).filter(
    (r) => r.atMs > 0 && r.atMs < TURN_ENDED_MS,
  );
  assert.ok(
    premature.length > 10,
    `expected the old window to fire mid-turn, got ${premature.length}`,
  );
});
