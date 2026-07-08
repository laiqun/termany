import { useEffect, useState } from "react";
import { apiPath } from "./api";
import claudeIcon from "./assets/agents/claudecode.svg?url";
import codexIcon from "./assets/agents/codex.svg?url";
import cursorIcon from "./assets/agents/cursor.svg?url";
import droidIcon from "./assets/agents/droid.svg?url";
import geminiIcon from "./assets/agents/gemini.svg?url";
import hermesIcon from "./assets/agents/hermes.webp?url";
import kilocodeIcon from "./assets/agents/kilocode.svg?url";
import kimiIcon from "./assets/agents/kimi.svg?url";
import ompIcon from "./assets/agents/omp.svg?url";
import openClawIcon from "./assets/agents/openclaw.svg?url";
import opencodeIcon from "./assets/agents/opencode.svg?url";

const STORAGE_KEY = "termany.agents";
const AGENTS_CHANGED_EVENT = "termany:agents-changed";
// Built-in agents that used to ship but were dropped. Kept so normalize()
// can strip stale localStorage entries instead of resurrecting them as
// "custom" agents.
const REMOVED_AGENT_IDS = new Set(["charm"]);

export type AgentConfig = {
  id: string;
  name: string;
  command: string;
  args: string;
  enabled: boolean;
  icon?: string;
  builtIn: boolean;
  detected?: boolean;
  detectedPath?: string;
};

type StoredAgentConfig = Partial<Omit<AgentConfig, "builtIn" | "detected" | "detectedPath">> & {
  id: string;
};

export const DEFAULT_AGENTS: AgentConfig[] = [
  {
    id: "claude",
    name: "Claude",
    command: "claude",
    args: "--dangerously-skip-permissions",
    enabled: true,
    icon: claudeIcon,
    builtIn: true,
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    args: "--dangerously-bypass-approvals-and-sandbox",
    enabled: true,
    icon: codexIcon,
    builtIn: true,
  },
  {
    id: "gemini",
    name: "Gemini",
    command: "gemini",
    args: "--yolo",
    enabled: false,
    icon: geminiIcon,
    builtIn: true,
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    command: "openclaw",
    args: "",
    enabled: true,
    icon: openClawIcon,
    builtIn: true,
  },
  {
    id: "hermes",
    name: "Hermes",
    command: "hermes",
    args: "",
    enabled: false,
    icon: hermesIcon,
    builtIn: true,
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: "",
    enabled: false,
    icon: opencodeIcon,
    builtIn: true,
  },
  {
    id: "kilocode",
    name: "Kilocode",
    command: "kilo",
    args: "",
    enabled: false,
    icon: kilocodeIcon,
    builtIn: true,
  },
  {
    id: "cursor",
    name: "Cursor",
    command: "cursor-agent",
    args: "",
    enabled: false,
    icon: cursorIcon,
    builtIn: true,
  },
  {
    id: "kimi",
    name: "Kimi",
    command: "kimi",
    args: "",
    enabled: false,
    icon: kimiIcon,
    builtIn: true,
  },
  {
    id: "droid",
    name: "Droid",
    command: "droid",
    args: "",
    enabled: false,
    icon: droidIcon,
    builtIn: true,
  },
  {
    id: "omp",
    name: "OMP",
    command: "omp",
    args: "",
    enabled: false,
    icon: ompIcon,
    builtIn: true,
  },
];

function storedShape(agent: AgentConfig): StoredAgentConfig {
  return {
    id: agent.id,
    name: agent.name,
    command: agent.command,
    args: agent.args,
    enabled: agent.enabled,
    icon: agent.builtIn ? undefined : agent.icon,
  };
}

function normalize(saved: StoredAgentConfig[]): AgentConfig[] {
  saved = saved.filter((agent) => !REMOVED_AGENT_IDS.has(agent.id));
  const savedById = new Map(saved.map((agent) => [agent.id, agent]));
  const defaultById = new Map(DEFAULT_AGENTS.map((agent) => [agent.id, agent]));

  // Preserve the order the user last saved (e.g. newly-added agents get
  // pinned to the front), falling back to DEFAULT_AGENTS order on first
  // load. Any default added later that isn't in a saved list yet is
  // appended so it still shows up.
  const order = saved.length ? saved.map((agent) => agent.id) : DEFAULT_AGENTS.map((agent) => agent.id);
  for (const agent of DEFAULT_AGENTS) {
    if (!order.includes(agent.id)) order.push(agent.id);
  }

  return order
    .map((id): AgentConfig | null => {
      const base = defaultById.get(id);
      const stored = savedById.get(id);
      if (base) {
        return { ...base, ...stored, icon: stored?.icon || base.icon, builtIn: true };
      }
      if (stored) {
        return {
          id: stored.id,
          name: stored.name?.trim() || stored.id,
          command: stored.command?.trim() || stored.id,
          args: stored.args ?? "",
          enabled: stored.enabled ?? true,
          icon: stored.icon,
          builtIn: false,
        };
      }
      return null;
    })
    .filter((agent): agent is AgentConfig => agent !== null);
}

export function loadAgentConfigs(): AgentConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return normalize([]);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return normalize([]);
    return normalize(parsed.filter((agent): agent is StoredAgentConfig => Boolean(agent?.id)));
  } catch {
    return normalize([]);
  }
}

export function saveAgentConfigs(agents: AgentConfig[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(agents.map(storedShape)));
  window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
}

export function agentCommand(agent: AgentConfig) {
  return [agent.command.trim(), agent.args.trim()].filter(Boolean).join(" ");
}

export function createCustomAgent(): AgentConfig {
  const id = crypto.randomUUID();
  return {
    id,
    name: "Custom Agent",
    command: "",
    args: "",
    enabled: true,
    builtIn: false,
  };
}

export async function detectAgentConfigs(agents: AgentConfig[]): Promise<AgentConfig[]> {
  const commands = agents.map((agent) => agent.command).filter(Boolean);
  const res = await fetch(apiPath("/api/agents/detect"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  const byCommand = new Map(
    (Array.isArray(data.results) ? data.results : []).map((r: any) => [
      String(r.command),
      { detected: Boolean(r.installed), detectedPath: typeof r.path === "string" ? r.path : undefined },
    ])
  );
  return agents.map((agent) => ({ ...agent, ...(byCommand.get(agent.command) ?? {}) }));
}

export function useAgentConfigs() {
  const [agents, setAgents] = useState(loadAgentConfigs);

  useEffect(() => {
    const onChange = () => setAgents(loadAgentConfigs());
    window.addEventListener(AGENTS_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(AGENTS_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  return agents;
}
