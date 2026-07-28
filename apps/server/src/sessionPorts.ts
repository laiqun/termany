/**
 * Which TCP ports each terminal pane is *currently* listening on.
 *
 * A pane prints `http://localhost:3035/` once, but that line stays in the
 * scrollback long after the dev server is gone — and the same output also
 * mentions a dozen ports that were tried and rejected ("Port 3000 is in use").
 * So the frontend never trusts the text alone: it intersects the URLs it saw
 * with the live answer from here, which is derived from the kernel rather than
 * from output.
 *
 * "This pane" means the pane's shell pid or any of its descendants — the dev
 * server is normally a grandchild (shell → npm → vite).
 *
 * Best-effort by design: on a machine without `lsof`/`ps` (or on Windows,
 * where neither exists in this form) every pane reports no ports and the
 * button simply never appears, exactly as it did before this feature.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Reuse one probe for this long — several panes ask on the same tick. */
const PROBE_TTL_MS = 2000;
const EXEC_TIMEOUT_MS = 2000;

export interface PortProbe {
  /** pid → TCP ports it listens on, ascending. */
  portsByPid: Map<number, number[]>;
  /** pid → parent pid. */
  parents: Map<number, number>;
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN`. A pid appears once per bound address —
 * IPv4 and IPv6 on the same port are two rows — hence the dedupe.
 */
export function parseListeningPorts(stdout: string): Map<number, number[]> {
  const byPid = new Map<number, Set<number>>();
  for (const line of stdout.split("\n")) {
    // "node  92310 benn  23u  IPv6 0x…  0t0  TCP *:3000 (LISTEN)"
    const pid = Number(/^\S+\s+(\d+)\s/.exec(line)?.[1]);
    // The address is the last field before (LISTEN): *:3000, 127.0.0.1:5432,
    // [::1]:8080 — take whatever follows the final colon.
    const port = Number(/\s\S+:(\d+)\s+\(LISTEN\)/.exec(line)?.[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(port)) continue;
    const hit = byPid.get(pid);
    if (hit) hit.add(port);
    else byPid.set(pid, new Set([port]));
  }
  return new Map([...byPid].map(([pid, ports]) => [pid, [...ports].sort((a, b) => a - b)]));
}

/** Parse `ps -Ao pid=,ppid=` into pid → ppid. */
export function parseProcessParents(stdout: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    parents.set(Number(m[1]), Number(m[2]));
  }
  return parents;
}

/** Walk up from `pid`; depth-capped so a malformed table can't spin forever. */
function isSelfOrDescendant(pid: number, rootPid: number, parents: Map<number, number>): boolean {
  for (let cur = pid, depth = 0; cur > 0 && depth < 64; depth++) {
    if (cur === rootPid) return true;
    const parent = parents.get(cur);
    if (!parent || parent === cur) return false;
    cur = parent;
  }
  return false;
}

/**
 * Ports listened to by `rootPid` or anything it spawned, ascending.
 *
 * Walks UP from each listening pid rather than expanding the whole tree
 * downwards: only a handful of processes on a machine listen at all, while the
 * process table has hundreds of rows.
 */
export function portsUnderPid(rootPid: number, probe: PortProbe): number[] {
  const ports = new Set<number>();
  for (const [pid, pidPorts] of probe.portsByPid) {
    if (!isSelfOrDescendant(pid, rootPid, probe.parents)) continue;
    for (const port of pidPorts) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

let cached: { at: number; probe: Promise<PortProbe> } | null = null;

async function runProbe(): Promise<PortProbe> {
  const empty: PortProbe = { portsByPid: new Map(), parents: new Map() };
  if (process.platform !== "darwin" && process.platform !== "linux") return empty;
  const opts = { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 };
  const [listeners, table] = await Promise.all([
    execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], opts).catch(() => null),
    execFileAsync("ps", ["-Ao", "pid=,ppid="], opts).catch(() => null),
  ]);
  if (!listeners || !table) return empty;
  return {
    portsByPid: parseListeningPorts(listeners.stdout),
    parents: parseProcessParents(table.stdout),
  };
}

/** One probe per TTL window, shared by every caller inside it. */
function probe(): Promise<PortProbe> {
  const now = Date.now();
  if (!cached || now - cached.at > PROBE_TTL_MS) {
    cached = { at: now, probe: runProbe() };
  }
  return cached.probe;
}

/** sessionId → listening ports, for the panes whose shell pid is given. */
export async function sessionListeningPorts(
  rootPids: Record<string, number>
): Promise<Record<string, number[]>> {
  const entries = Object.entries(rootPids);
  if (!entries.length) return {};
  const current = await probe();
  const out: Record<string, number[]> = {};
  for (const [sessionId, pid] of entries) {
    const ports = portsUnderPid(pid, current);
    if (ports.length) out[sessionId] = ports;
  }
  return out;
}
