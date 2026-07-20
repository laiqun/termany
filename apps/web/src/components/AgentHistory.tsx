import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentConfigs } from "../agents";
import { apiPath } from "../api";
import { agentSessionPanes, useStore } from "../state/store";
import { queueCommand } from "../terminal/manager";
import { AgentIcon, HistoryIcon } from "./icons";

interface AgentSession {
  sessionId: string;
  cwd: string | null;
  preview: string;
  mtimeMs: number;
  totalTokens: number | null;
  contextTokens: number | null;
}

/** How each supported agent resumes a session id from inside its project dir. */
const RESUME_COMMANDS: Record<string, (sessionId: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
};

/**
 * A transcript written to this recently is treated as a live conversation —
 * probably still running in some terminal (maybe outside termany, where we
 * can't jump to it). Resuming a live claude session forks it instead, because
 * two claude processes appending to one transcript interleave its history.
 */
const ACTIVE_WINDOW_MS = 2 * 60_000;
const FORK_FLAGS: Record<string, string> = { claude: "--fork-session" };

/** POSIX single-quote so an arbitrary project path survives the shell. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Collapse the home-dir prefix so project paths read short in the list. */
function tildify(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function relativeTime(mtimeMs: number): string {
  const mins = Math.floor((Date.now() - mtimeMs) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(mtimeMs).toLocaleDateString();
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/**
 * Agent session-history browser: one tab per enabled agent, each listing that
 * CLI's past conversations newest-first with folder / recency / token totals /
 * context size, read server-side from the agent's own on-disk transcript
 * format (claude and codex today — other agents show a not-supported note).
 * Selecting a session opens a fresh terminal pane, cd's to the session's own
 * project directory (resume only works from there), and runs the agent's
 * resume command. Same modal skeleton and styles as SearchPalette.
 */
export function AgentHistory({ onClose }: { onClose: () => void }) {
  const addPane = useStore((s) => s.addPane);
  const jumpToResult = useStore((s) => s.jumpToResult);
  const setPaneAgentSession = useStore((s) => s.setPaneAgentSession);
  const workspaces = useStore((s) => s.workspaces);
  const agents = useAgentConfigs().filter((a) => a.enabled);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "claude");
  // agent id → fetched sessions; null = unsupported, undefined = not loaded.
  const [byAgent, setByAgent] = useState<Record<string, AgentSession[] | null>>({});
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessions = byAgent[agentId];
  const agentName = agents.find((a) => a.id === agentId)?.name ?? agentId;

  useEffect(() => {
    if (agentId in byAgent) return;
    let cancelled = false;
    setError(false);
    fetch(apiPath(`/api/agent-sessions?agent=${encodeURIComponent(agentId)}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (!cancelled) setByAgent((m) => ({ ...m, [agentId]: data.sessions ?? null }));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, byAgent]);

  // Server order is already newest-first; filtering preserves it.
  const rows = useMemo(() => {
    if (!sessions) return [];
    const q = query.trim().toLowerCase();
    return q
      ? sessions.filter(
          (s) => s.preview.toLowerCase().includes(q) || (s.cwd ?? "").toLowerCase().includes(q)
        )
      : sessions;
  }, [sessions, query]);

  useEffect(() => setSelected(0), [rows]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Conversations already hosted by an open pane (registered on resume).
  const openPanes = useMemo(() => agentSessionPanes(workspaces), [workspaces]);

  const resume = (s: AgentSession) => {
    // Already open in a pane → go there instead of resuming a second copy.
    const loc = openPanes.get(`${agentId}|${s.sessionId}`);
    if (loc) {
      jumpToResult(loc);
      onClose();
      return;
    }
    const resumeCommand = RESUME_COMMANDS[agentId];
    if (!resumeCommand) return;
    const fork = FORK_FLAGS[agentId];
    const isLive = Date.now() - s.mtimeMs < ACTIVE_WINDOW_MS;
    const run = resumeCommand(s.sessionId) + (fork && isLive ? ` ${fork}` : "");
    const paneId = addPane("terminal", agentId);
    if (paneId) {
      queueCommand(paneId, s.cwd ? `cd ${shellQuote(s.cwd)} && ${run}` : run);
      setPaneAgentSession(paneId, { agent: agentId, sessionId: s.sessionId });
    }
    onClose();
  };

  const switchAgent = (id: string) => {
    setAgentId(id);
    setQuery("");
    inputRef.current?.focus();
  };

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="search-palette search-palette-lg" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <span className="search-input-ico">
            <HistoryIcon />
          </span>
          <input
            ref={inputRef}
            className="search-input"
            autoFocus
            autoCorrect="off"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={query}
            placeholder={`Search ${agentName} sessions…`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") {
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((i) => Math.min(i + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const row = rows[selected];
                if (row) resume(row);
              }
            }}
          />
        </div>

        <div className="history-tabs">
          {agents.map((a) => (
            <button
              key={a.id}
              className={`history-tab ${a.id === agentId ? "active" : ""}`}
              onClick={() => switchAgent(a.id)}
            >
              {a.icon ? (
                <img className="history-tab-icon" src={a.icon} alt="" aria-hidden="true" />
              ) : (
                <span className="history-tab-icon fallback">
                  <AgentIcon />
                </span>
              )}
              <span>{a.name}</span>
            </button>
          ))}
        </div>

        <div className="search-results" ref={listRef}>
          {error && <div className="search-empty">Could not load session history.</div>}
          {!error && sessions === undefined && <div className="search-empty">Loading sessions…</div>}
          {!error && sessions === null && (
            <div className="search-empty">Session history isn't supported for {agentName} yet.</div>
          )}
          {!error && Array.isArray(sessions) && rows.length === 0 && (
            <div className="search-empty">
              {query.trim() ? `No sessions match "${query.trim()}".` : `No ${agentName} sessions found.`}
            </div>
          )}
          {rows.map((s, idx) => {
            const isOpen = openPanes.has(`${agentId}|${s.sessionId}`);
            const isLive = !isOpen && Date.now() - s.mtimeMs < ACTIVE_WINDOW_MS;
            const meta = [
              relativeTime(s.mtimeMs),
              s.totalTokens !== null ? `${formatTokens(s.totalTokens)} tokens` : null,
              s.contextTokens !== null ? `${formatTokens(s.contextTokens)} ctx` : null,
              s.cwd ? tildify(s.cwd) : null,
            ].filter(Boolean);
            return (
              <button
                key={s.sessionId}
                data-idx={idx}
                className={`search-row pane ${idx === selected ? "active" : ""}`}
                onMouseEnter={() => setSelected(idx)}
                onClick={() => resume(s)}
              >
                <span className="search-row-main">
                  <span className="search-row-label">{s.preview || "(empty session)"}</span>
                  <span className="search-row-breadcrumb">{meta.join(" · ")}</span>
                </span>
                {isOpen && (
                  <span className="history-badge open" title="Already open — click to jump to its pane">
                    open
                  </span>
                )}
                {isLive && (
                  <span className="history-badge live" title="Recently active — resuming forks a new conversation">
                    active
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
