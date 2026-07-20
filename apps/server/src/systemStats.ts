/**
 * Machine-level CPU / memory sampling for the SideRail system monitor.
 *
 * Everything here shells out to tools already present on the platform (`ps`,
 * `vm_stat`) instead of pulling in a native dependency — the numbers only need
 * to be good enough to answer "what's making the fan spin".
 */
import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ProcessStat {
  /** Aggregated over every process sharing this name (see `count`). */
  name: string;
  /** Percent of one core, summed across instances — same scale as Activity Monitor. */
  cpu: number;
  memBytes: number;
  count: number;
  /** Representative pid (the biggest CPU consumer in the group). */
  pid: number;
}

export interface SystemStats {
  cpu: {
    /** Whole-machine utilization, 0–100. */
    usage: number;
    cores: number;
    loadavg: [number, number, number];
  };
  memory: { total: number; used: number };
  processes: ProcessStat[];
  uptimeSec: number;
}

// Tuned to fill the fixed-height monitor panel without spilling into a scroll
// at its 720px ceiling — see .usage-modal / .sysmon-row in styles.css.
const TOP_PROCESSES = 20;

// os.cpus() reports cumulative counters, so utilization is the delta between
// two samples. The poll interval supplies that gap; the first call after a
// cold start takes its own short sample instead.
let prev: { idle: number; total: number } | null = null;

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === "idle") idle += ms;
    }
  }
  return { idle, total };
}

async function cpuUsage(): Promise<number> {
  if (!prev) {
    prev = cpuTimes();
    await new Promise((r) => setTimeout(r, 150));
  }
  const now = cpuTimes();
  const idleDelta = now.idle - prev.idle;
  const totalDelta = now.total - prev.total;
  prev = now;
  if (totalDelta <= 0) return 0;
  return Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100));
}

/**
 * "Memory used" the way Activity Monitor means it. os.freemem() on macOS
 * counts only the free list, so total-free reads as ~100% used on any machine
 * that has been up for a while — vm_stat's active/wired/compressed is the
 * number people actually recognize.
 */
async function memoryUsed(total: number): Promise<number> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execAsync("vm_stat");
      const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 4096);
      const pages = (label: string) =>
        Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
      const used =
        (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) *
        pageSize;
      if (used > 0) return Math.min(total, used);
    } catch {
      /* fall through to the portable estimate */
    }
  }
  if (process.platform === "linux") {
    try {
      const meminfo = await fs.promises.readFile("/proc/meminfo", "utf8");
      const available = Number(/MemAvailable:\s+(\d+) kB/.exec(meminfo)?.[1] ?? 0) * 1024;
      if (available > 0) return Math.max(0, total - available);
    } catch {
      /* fall through */
    }
  }
  return Math.max(0, total - os.freemem());
}

/**
 * Top processes by CPU, grouped by executable name — a browser with 40 helper
 * processes should read as one heavy app, not flood the whole list.
 */
async function topProcesses(): Promise<ProcessStat[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  let stdout: string;
  try {
    ({ stdout } = await execAsync("ps -Ao pid=,pcpu=,rss=,comm=", { maxBuffer: 8 * 1024 * 1024 }));
  } catch {
    return []; // ps missing or sandboxed away — the header stats still work
  }

  const byName = new Map<string, ProcessStat>();
  for (const line of stdout.split("\n")) {
    // comm can contain spaces (".../OrbStack Helper"), so only split the
    // three fixed numeric columns off the front.
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pidStr, cpuStr, rssStr, comm] = m;
    const name = path.basename(comm.trim()) || comm.trim();
    if (!name) continue;
    const cpu = Number(cpuStr);
    const memBytes = Number(rssStr) * 1024;
    const hit = byName.get(name);
    if (hit) {
      hit.cpu += cpu;
      hit.memBytes += memBytes;
      hit.count++;
      if (cpu > hit.cpu / hit.count) hit.pid = Number(pidStr);
    } else {
      byName.set(name, { name, cpu, memBytes, count: 1, pid: Number(pidStr) });
    }
  }

  return [...byName.values()].sort((a, b) => b.cpu - a.cpu || b.memBytes - a.memBytes).slice(0, TOP_PROCESSES);
}

export async function readSystemStats(): Promise<SystemStats> {
  const total = os.totalmem();
  const [usage, used, processes] = await Promise.all([cpuUsage(), memoryUsed(total), topProcesses()]);
  const [l1, l5, l15] = os.loadavg();
  return {
    cpu: { usage, cores: os.cpus().length, loadavg: [l1, l5, l15] },
    memory: { total, used },
    processes,
    uptimeSec: os.uptime(),
  };
}
