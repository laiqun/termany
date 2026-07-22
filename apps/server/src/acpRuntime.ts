import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ActiveSession,
  type ClientConnection,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { findAgentConfig, type AgentConfig } from "./agentConfig.js";

export type AcpRuntimeEvent =
  | { type: "delta"; text: string }
  | { type: "thought"; text: string }
  | { type: "activity"; title: string; status?: string }
  | { type: "tool"; id: string; title?: string; status?: string; input?: string; output?: string }
  | { type: "permission"; requestId: string; title: string; options: PermissionOption[] }
  | { type: "done"; sessionId: string };

type Emit = (event: AcpRuntimeEvent) => void;

const execFileAsync = promisify(execFile);

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) args.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote in runtime arguments");
  if (current) args.push(current);
  return args;
}

async function executablePath(command: string): Promise<string> {
  if (command.includes("/") || command.includes("\\")) {
    await fs.promises.access(command, fs.constants.X_OK);
    return command;
  }
  const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/zsh");
  const quoted = `'${command.replace(/'/g, "'\\''")}'`;
  try {
    const { stdout } = process.platform === "win32"
      ? await execFileAsync("where.exe", [command], { timeout: 2500 })
      : await execFileAsync(shell, ["-lc", `command -v -- ${quoted}`], { timeout: 2500 });
    const found = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (found) return found;
  } catch {
    // The friendly error below includes the configured command.
  }
  throw new Error(`Agent runtime command not found: ${command}`);
}

function textFromUpdate(update: SessionUpdate): string | undefined {
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return;
  const content = update.content;
  return content.type === "text" ? content.text : undefined;
}

/** Keep tool detail blobs bounded — they persist with the conversation. */
const TOOL_DETAIL_LIMIT = 10_000;

function clipDetail(text: string): string | undefined {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed.trim()) return undefined;
  return trimmed.length > TOOL_DETAIL_LIMIT ? `${trimmed.slice(0, TOOL_DETAIL_LIMIT)}…` : trimmed;
}

/** Shell-style tools show their command as `$ …`; anything else pretty JSON. */
function formatToolInput(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const command = (raw as { command?: unknown }).command;
  if (typeof command === "string" && command.trim()) return clipDetail(`$ ${command}`);
  try {
    return clipDetail(JSON.stringify(raw, null, 2));
  } catch {
    return undefined;
  }
}

function formatToolOutput(content: unknown, rawOutput: unknown): string | undefined {
  const items = Array.isArray(content) ? content : [];
  const chunks = items
    .map((item: { type?: string; content?: { type?: string; text?: string } }) =>
      item?.type === "content" && item.content?.type === "text" ? item.content.text ?? "" : ""
    )
    .filter(Boolean);
  if (chunks.length) return clipDetail(chunks.join("\n"));
  if (rawOutput == null) return undefined;
  if (typeof rawOutput === "string") return clipDetail(rawOutput);
  try {
    return clipDetail(JSON.stringify(rawOutput, null, 2));
  } catch {
    return undefined;
  }
}

class Runtime {
  private emit: Emit | null = null;
  private prompting = false;
  private stderr = "";
  private pendingPermissions = new Map<
    string,
    { resolve: (response: RequestPermissionResponse) => void; options: PermissionOption[] }
  >();

  private constructor(
    readonly paneId: string,
    readonly agent: AgentConfig,
    readonly cwd: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: ClientConnection,
    private readonly session: ActiveSession
  ) {
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-8_000);
    });
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      this.connection.close(new Error(`Agent runtime exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
      this.cancelPermissions();
      runtimes.delete(paneId);
    });
  }

  static async create(paneId: string, agent: AgentConfig, cwd: string): Promise<Runtime> {
    const spec = agent.runtime;
    if (!spec || spec.protocol !== "acp") throw new Error(`${agent.name} has no ACP runtime configured`);
    if (spec.distribution === "managed") {
      throw new Error(`The managed ${agent.name} runtime is not installed yet; switch its installation to System or Custom`);
    }
    if (spec.modelSource === "termany") {
      throw new Error("Termany model routing for ACP runtimes is not available yet; choose Agent-managed models");
    }

    const command = await executablePath(spec.command);
    const child = spawn(command, splitArgs(spec.args), {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let runtime!: Runtime;
    const app = client({ name: "Termany" }).onRequest(
      methods.client.session.requestPermission,
      ({ params }) => runtime.requestPermission(params)
    );
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );
    const connection = app.connect(stream);
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "Termany", version: "0.1.21" },
      });
      const session = await connection.agent.buildSession(cwd).start();
      runtime = new Runtime(paneId, agent, cwd, child, connection, session);
      return runtime;
    } catch (error) {
      connection.close(error);
      child.kill();
      const detail = runtime?.stderr?.trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `: ${detail}` : ""}`);
    }
  }

  async prompt(text: string, emit: Emit, signal: AbortSignal): Promise<void> {
    if (this.prompting) throw new Error("This agent is already responding");
    this.prompting = true;
    this.emit = emit;
    const cancel = () => void this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.session.sessionId });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      void this.session.prompt(text).catch(() => undefined);
      while (true) {
        const message = await this.session.nextUpdate();
        if (message.kind === "stop") break;
        const update = message.update;
        const textChunk = textFromUpdate(update);
        if (textChunk) {
          emit({ type: update.sessionUpdate === "agent_thought_chunk" ? "thought" : "delta", text: textChunk });
        } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          // tool_call_update carries only changed fields; the client merges by id.
          emit({
            type: "tool",
            id: update.toolCallId,
            title: update.title ?? undefined,
            status: update.status ?? undefined,
            input: formatToolInput(update.rawInput),
            output: formatToolOutput(update.content, update.rawOutput),
          });
        }
      }
      emit({ type: "done", sessionId: this.session.sessionId });
    } finally {
      signal.removeEventListener("abort", cancel);
      this.emit = null;
      this.prompting = false;
      if (signal.aborted) this.cancelPermissions();
    }
  }

  respondPermission(requestId: string, optionId: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || !pending.options.some((option) => option.optionId === optionId)) return false;
    this.pendingPermissions.delete(requestId);
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    return true;
  }

  close(): void {
    this.cancelPermissions();
    this.session.dispose();
    this.connection.close();
    this.child.kill();
  }

  private requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.emit) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const requestId = randomUUID();
    this.emit({
      type: "permission",
      requestId,
      title: params.toolCall.title || "Allow this action?",
      options: params.options,
    });
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { resolve, options: params.options });
    });
  }

  private cancelPermissions(): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
  }
}

const runtimes = new Map<string, Runtime>();

export async function promptAcpRuntime(input: {
  paneId: string;
  agentId: string;
  cwd: string;
  /** True when the user picked the folder explicitly. Only then does a cwd
   *  mismatch restart the session — the inherited terminal cwd drifts as the
   *  user `cd`s around, and that must never kill a live conversation. */
  cwdExplicit?: boolean;
  prompt: string;
  signal: AbortSignal;
  emit: Emit;
}): Promise<void> {
  input.emit({ type: "activity", title: "Starting agent", status: input.agentId });
  let runtime = runtimes.get(input.paneId);
  if (runtime && (runtime.agent.id !== input.agentId || (input.cwdExplicit && runtime.cwd !== input.cwd))) {
    runtime.close();
    runtimes.delete(input.paneId);
    runtime = undefined;
  }
  if (!runtime) {
    const agent = findAgentConfig(input.agentId);
    if (!agent || !agent.enabled) throw new Error("Agent runtime is missing or disabled");
    runtime = await Runtime.create(input.paneId, agent, input.cwd || os.homedir());
    runtimes.set(input.paneId, runtime);
  }
  input.emit({ type: "activity", title: runtime.agent.name, status: "Thinking" });
  await runtime.prompt(input.prompt, input.emit, input.signal);
}

/** The folder a pane's live ACP session is actually bound to, if one exists. */
export function acpRuntimeCwd(paneId: string): string | undefined {
  return runtimes.get(paneId)?.cwd;
}

export function respondAcpPermission(paneId: string, requestId: string, optionId: string): boolean {
  return runtimes.get(paneId)?.respondPermission(requestId, optionId) ?? false;
}

export function closeAcpRuntimes(paneIds: string[]): void {
  for (const paneId of paneIds) {
    runtimes.get(paneId)?.close();
    runtimes.delete(paneId);
  }
}

export function closeAllAcpRuntimes(): void {
  closeAcpRuntimes([...runtimes.keys()]);
}
