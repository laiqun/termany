import { useEffect, useRef, useState } from "react";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import { ActivityIcon } from "./icons";

type Translate = ReturnType<typeof useI18n>["t"];

interface ProcessStat {
  name: string;
  cpu: number; // percent of one core, summed across instances
  memBytes: number;
  count: number;
  pid: number;
}

interface SystemStats {
  cpu: { usage: number; cores: number; loadavg: [number, number, number] };
  memory: { total: number; used: number };
  processes: ProcessStat[];
  uptimeSec: number;
}

const POLL_MS = 2000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 2 : 1)} GB`;
}

function formatUptime(sec: number, t: Translate): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return t("monitor.uptime.d", { d, h });
  if (h > 0) return t("monitor.uptime.h", { h, m });
  return t("monitor.uptime.m", { m });
}

/**
 * Machine resource monitor (the SideRail activity button): overall CPU and
 * memory plus the heaviest processes, grouped by executable name. Polls while
 * open and stops on close — see /api/system-stats. Shares the usage
 * dashboard's modal skeleton so the two feel like one family.
 */
export function SystemMonitor({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [stats, setStats] = useState<SystemStats | null | undefined>(undefined);
  // Keep the last good sample on screen if one poll fails, so the numbers
  // don't blink out on a transient hiccup.
  const failures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number;

    const poll = async () => {
      try {
        const r = await fetch(apiPath("/api/system-stats"));
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as SystemStats;
        if (!cancelled) {
          failures.current = 0;
          setStats(data);
        }
      } catch {
        if (!cancelled && ++failures.current >= 2) setStats((s) => (s ? s : null));
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
    };

    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const memPct = stats ? (stats.memory.used / stats.memory.total) * 100 : 0;
  // Process CPU is per-core-summed, so the busiest process sets the scale.
  const cpuMax = Math.max(1, ...(stats?.processes ?? []).map((p) => p.cpu));
  const memMax = Math.max(1, ...(stats?.processes ?? []).map((p) => p.memBytes));

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="usage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="usage-header">
          <span className="usage-title">
            <ActivityIcon />
            <span>{t("monitor.title")}</span>
          </span>
          {stats && (
            <span className="sysmon-meta">
              {t("monitor.meta", {
                cores: stats.cpu.cores,
                uptime: formatUptime(stats.uptimeSec, t),
              })}
            </span>
          )}
        </div>

        {stats === undefined && <div className="search-empty">{t("monitor.loading")}</div>}
        {stats === null && <div className="search-empty">{t("monitor.error")}</div>}

        {stats && (
          <div className="usage-body">
            <div className="sysmon-gauges">
              <div className="usage-card">
                <span className="usage-card-label">CPU</span>
                <span className="usage-card-value">{stats.cpu.usage.toFixed(0)}%</span>
                <span className="sysmon-meter">
                  <i style={{ width: `${stats.cpu.usage}%` }} />
                </span>
                <span className="usage-card-note">
                  {t("monitor.load", {
                    values: stats.cpu.loadavg.map((l) => l.toFixed(2)).join(" · "),
                  })}
                </span>
              </div>
              <div className="usage-card">
                <span className="usage-card-label">{t("monitor.memory")}</span>
                <span className="usage-card-value">{memPct.toFixed(0)}%</span>
                <span className="sysmon-meter">
                  <i className={memPct > 85 ? "hot" : ""} style={{ width: `${memPct}%` }} />
                </span>
                <span className="usage-card-note">
                  {t("monitor.memOf", {
                    used: formatBytes(stats.memory.used),
                    total: formatBytes(stats.memory.total),
                  })}
                </span>
              </div>
            </div>

            <div className="usage-section">
              <div className="usage-section-head">
                <span>{t("monitor.top")}</span>
                <span className="usage-legend-note">{t("monitor.sortNote")}</span>
              </div>
              {stats.processes.length === 0 ? (
                <div className="search-empty">{t("monitor.unsupported")}</div>
              ) : (
                <div className="usage-models">
                  <div className="sysmon-row head">
                    <span>{t("monitor.col.process")}</span>
                    <span />
                    <span>CPU</span>
                    <span>{t("monitor.col.memory")}</span>
                  </div>
                  {stats.processes.map((p) => (
                    <div key={p.name} className="sysmon-row">
                      <span
                        className="usage-model-name"
                        title={t("monitor.pidTitle", { name: p.name, pid: p.pid })}
                      >
                        {p.name}
                        {p.count > 1 && <em className="sysmon-count">×{p.count}</em>}
                      </span>
                      <span className="sysmon-bars">
                        <span className="usage-model-bar">
                          <i style={{ width: `${(p.cpu / cpuMax) * 100}%` }} />
                        </span>
                        <span className="usage-model-bar">
                          <i className="mem" style={{ width: `${(p.memBytes / memMax) * 100}%` }} />
                        </span>
                      </span>
                      <span className="usage-model-tokens">{p.cpu.toFixed(1)}%</span>
                      <span className="usage-model-cost">{formatBytes(p.memBytes)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
