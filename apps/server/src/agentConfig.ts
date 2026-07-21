import { getAgentsRaw, setAgentsRaw } from "./db.js";

export type AgentDistribution = "managed" | "system" | "custom";
export type AgentModelSource = "termany" | "agent";

export interface AgentRuntimeConfig {
  protocol: "acp";
  command: string;
  args: string;
  distribution: AgentDistribution;
  modelSource: AgentModelSource;
}

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string;
  enabled: boolean;
  icon?: string;
  builtIn: boolean;
  runtime?: AgentRuntimeConfig | null;
}

const BUILTIN_AGENTS: AgentConfig[] = [
  { id: "claude", name: "Claude", command: "claude", args: "--dangerously-skip-permissions", enabled: true, builtIn: true },
  { id: "codex", name: "Codex", command: "codex", args: "--dangerously-bypass-approvals-and-sandbox", enabled: true, builtIn: true },
  { id: "gemini", name: "Gemini", command: "gemini", args: "--yolo", enabled: false, builtIn: true },
  { id: "openclaw", name: "OpenClaw", command: "openclaw", args: "", enabled: true, builtIn: true },
  { id: "fastclaw", name: "FastClaw", command: "fastclaw", args: "", enabled: false, builtIn: true },
  { id: "hermes", name: "Hermes", command: "hermes", args: "", enabled: false, builtIn: true },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: "",
    enabled: false,
    builtIn: true,
    runtime: {
      protocol: "acp",
      command: "opencode",
      args: "acp",
      distribution: "system",
      modelSource: "agent",
    },
  },
  { id: "kilocode", name: "Kilocode", command: "kilo", args: "", enabled: false, builtIn: true },
  { id: "cursor", name: "Cursor", command: "cursor-agent", args: "", enabled: false, builtIn: true },
  { id: "kimi", name: "Kimi", command: "kimi", args: "", enabled: false, builtIn: true },
  { id: "droid", name: "Droid", command: "droid", args: "", enabled: false, builtIn: true },
  { id: "omp", name: "OMP", command: "omp", args: "", enabled: false, builtIn: true },
];

function runtime(input: any): AgentRuntimeConfig | undefined {
  if (!input || input.protocol !== "acp") return undefined;
  const command = String(input.command ?? "").trim();
  if (!command) return undefined;
  return {
    protocol: "acp",
    command,
    args: String(input.args ?? "").trim(),
    distribution: input.distribution === "managed" || input.distribution === "custom" ? input.distribution : "system",
    modelSource: input.modelSource === "termany" ? "termany" : "agent",
  };
}

function sanitize(input: any, builtIn = false, fallback?: AgentConfig): AgentConfig | null {
  const id = String(input?.id ?? "").trim();
  if (!id) return null;
  const command = String(input?.command ?? "").trim();
  return {
    id,
    name: String(input?.name ?? "").trim() || id,
    command,
    args: String(input?.args ?? "").trim(),
    enabled: input?.enabled !== false,
    icon: typeof input?.icon === "string" ? input.icon : undefined,
    builtIn,
    runtime: Object.prototype.hasOwnProperty.call(input ?? {}, "runtime")
      ? input?.runtime === null
        ? null
        : runtime(input?.runtime)
      : fallback?.runtime,
  };
}

export function listAgentConfigs(): { agents: AgentConfig[]; persisted: boolean } {
  const raw = getAgentsRaw();
  if (!raw) return { agents: BUILTIN_AGENTS, persisted: false };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("invalid agents config");
    const builtIns = new Map(BUILTIN_AGENTS.map((agent) => [agent.id, agent]));
    const agents = parsed
      .map((item) => {
        const fallback = builtIns.get(String(item?.id ?? ""));
        return sanitize(item, Boolean(fallback), fallback);
      })
      .filter((item): item is AgentConfig => item !== null);
    return { agents, persisted: true };
  } catch {
    return { agents: BUILTIN_AGENTS, persisted: false };
  }
}

export function saveAgentConfigs(input: unknown): AgentConfig[] {
  if (!Array.isArray(input)) throw new Error("agents must be an array");
  const builtIns = new Map(BUILTIN_AGENTS.map((agent) => [agent.id, agent]));
  const agents = input
    .slice(0, 64)
    .map((item) => {
      const fallback = builtIns.get(String(item?.id ?? ""));
      return sanitize(item, Boolean(fallback), fallback);
    })
    .filter((item): item is AgentConfig => item !== null);
  setAgentsRaw(JSON.stringify(agents));
  return agents;
}

export function findAgentConfig(id: string): AgentConfig | undefined {
  return listAgentConfigs().agents.find((agent) => agent.id === id);
}
