import { WebSocketBackend, type ITerminalBackend } from "@termany/core";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { apiUrl } from "../api";
import { DemoBackend, demoInteracted, isDemo } from "../demo";
import { ACTIONS, loadKeybindings, matchChord } from "../keybindings";
import { registerLocalPathLinks } from "./localLinks";
import { registerWebLinks } from "./webLinks";

/**
 * The terminal session registry.
 *
 * Each pane maps to ONE Session that lives here, OUTSIDE React, so its shell and
 * scrollback survive being backgrounded (Wave / VS Code do the same).
 *
 * IMPORTANT: a Terminal must be `open()`ed into an element that is already in the
 * document — opening into a detached node leaves the renderer mis-initialised and
 * nothing paints but the cursor. So we create everything in getSession() but defer
 * open() to attachSession(), once the host is mounted.
 */

const WS_URL = import.meta.env.VITE_PTY_URL ?? "ws://localhost:5174";

export interface Session {
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  backend: ITerminalBackend;
  opened: boolean;
  followOutput: boolean;
  manualScrollUntil: number;
  deferredOutput: string[];
  deferredSince: number;
  deferredFlushTimer: number | null;
  spawnedAt: number;
  restartAttempts: number;
}

/**
 * The shell exiting on its own (typed `exit`, crashed) used to just leave the
 * pane dead with a "[session ended]" message — the user had to close the tab
 * and reopen a new one to keep working. Auto-respawning a fresh shell in the
 * same pane instead makes that recoverable by default. Capped so a shell
 * that dies instantly on every launch (bad rc file, missing binary) doesn't
 * spin forever — the counter resets once a shell survives a little while, so
 * this only kicks in for a tight crash loop, not e.g. someone repeatedly
 * typing `exit`.
 */
const MAX_AUTO_RESTARTS = 5;
const RESTART_HEALTHY_MS = 3000;

/**
 * A mouse-wheel scroll only moves xterm's DOM scroll container immediately;
 * the row-based position it tracks internally for auto-follow (`ydisp`) is
 * only updated once the resulting native `scroll` event round-trips back
 * asynchronously. If a PTY write lands inside that gap, xterm's own core
 * buffer logic (which advances `ydisp` alongside new content whenever
 * `ydisp === ybase`, i.e. "was at the bottom") still sees the pre-scroll
 * state and re-pins to the bottom on its own — no explicit scrollToBottom()
 * call of ours involved, so gating just those calls (below) isn't enough.
 * Under fast/continuous output the gap can be starved for a while (writes
 * keep the main thread busy ahead of the queued scroll event), so instead
 * PTY data arriving inside a short window after a wheel tick is held back
 * from `term.write()` entirely, giving xterm's scroll round-trip a clear
 * chance to land before any new content can trigger that internal re-pin.
 */
const MANUAL_SCROLL_COOLDOWN_MS = 500;
/** Hard ceiling on how long output can be held back, even if the user keeps scrolling. */
const MAX_DEFER_MS = 1500;

export function noteManualScroll(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  session.manualScrollUntil = Date.now() + MANUAL_SCROLL_COOLDOWN_MS;
}

function writeSessionData(id: string, data: string) {
  const session = sessions.get(id);
  if (!session) return;
  const now = Date.now();
  const withinCooldown = now < session.manualScrollUntil;
  const withinDeferCeiling = !session.deferredSince || now - session.deferredSince < MAX_DEFER_MS;
  if (withinCooldown && withinDeferCeiling) {
    if (!session.deferredOutput.length) session.deferredSince = now;
    session.deferredOutput.push(data);
    scheduleDeferredFlush(id);
    return;
  }
  session.term.write(data, () => {
    completeAgentActivityIfIdle(id);
    if (session.followOutput && Date.now() >= session.manualScrollUntil) settleSessionAtBottom(id);
    else notifyScrollState(id);
  });
}

function scheduleDeferredFlush(id: string) {
  const session = sessions.get(id);
  if (!session || session.deferredFlushTimer !== null) return;
  const delay = Math.max(0, session.manualScrollUntil - Date.now()) + 16;
  session.deferredFlushTimer = window.setTimeout(() => {
    const latest = sessions.get(id);
    if (!latest) return;
    latest.deferredFlushTimer = null;
    flushDeferredOutput(id);
  }, delay);
}

function flushDeferredOutput(id: string) {
  const session = sessions.get(id);
  if (!session || !session.deferredOutput.length) return;
  const now = Date.now();
  if (now < session.manualScrollUntil && now - session.deferredSince < MAX_DEFER_MS) {
    scheduleDeferredFlush(id);
    return;
  }
  const combined = session.deferredOutput.splice(0).join("");
  session.deferredSince = 0;
  session.term.write(combined, () => {
    completeAgentActivityIfIdle(id);
    if (session.followOutput && Date.now() >= session.manualScrollUntil) settleSessionAtBottom(id);
    else notifyScrollState(id);
  });
}

export type TerminalScrollState = {
  hasOverflow: boolean;
  atTop: boolean;
  atBottom: boolean;
};

const sessions = new Map<string, Session>();
const pendingCommands = new Map<string, string[]>();
const scrollListeners = new Map<string, Set<(state: TerminalScrollState) => void>>();

export type AgentActivityStatus = "working" | "done" | "error";

export type AgentActivity = {
  status: AgentActivityStatus;
  agent?: "claude" | "codex";
  updatedAt: number;
};

const agentActivities = new Map<string, AgentActivity>();
const agentActivityListeners = new Set<() => void>();
const agentSessionKinds = new Map<string, AgentActivity["agent"]>();

const AGENT_RE = /\b(OpenAI Codex|Codex CLI|Claude Code)\b|Use \/skills|\/model to change|bypass permissions/i;
const CODEX_RE = /\b(OpenAI Codex|Codex CLI)\b/i;
const CLAUDE_RE = /\bClaude Code\b/i;
const AGENT_COMMAND_RE = /^\s*(claude|codex)(?:\s|$)/i;
const ERROR_RE =
  /\b(error|failed|failure|exception|fatal|panic|permission denied|timed out|rate limit|quota|authentication|unauthorized|forbidden|command not found)\b/i;
const BENIGN_ERROR_RE = /\b(no errors?|0 errors?|without errors?)\b/i;
const DONE_RE =
  /(?:^|\b)(done|completed|complete|finished|success|succeeded)(?:\b|$)|all checks passed|task complete|changes? applied|implementation complete/i;
const WORKING_RE = /\b(working|thinking|running|executing|editing|applying|building|testing|installing|searching|reading)\b/i;
const ALT_SCREEN_EXIT_RE = /\x1b\[\?1049l|\x1b\[\?47l|\x1b\[\?1047l/;
const SHELL_PROMPT_RE = /(?:^|\n)[^\n]{0,96}(?:[$%#❯➜])\s*$/;
const AGENT_IDLE_PROMPT_RE = /(?:^|\n)\s*[›>]\s*$/;
// Matches ONE row that agentInputPromptVisible() has already stripped of box
// chrome: the agent's input marker, bare (idle) or with typed text after it.
const AGENT_INPUT_PROMPT_RE = /^[›>](?:\s|$)/;
// Vertical box-drawing edges + padding around that row. Agent CLIs draw their
// input inside a border, so the raw row reads "│ › fix a bug in @file      │".
const BOX_CHROME_RE = /^[\s│┃┆┊╎╏|]+|[\s│┃┆┊╎╏|]+$/g;
// How many non-empty rows up from the bottom to search for the input row. It is
// rarely the last one — a bottom border and a hint line ("? for shortcuts")
// usually sit below it.
const AGENT_PROMPT_SCAN_ROWS = 6;
const DONE_ACTIVITY_TTL_MS = 30_000;
const ERROR_ACTIVITY_TTL_MS = 5 * 60_000;
const WORKING_ACTIVITY_STALE_MS = 2 * 60_000;
let agentActivityPruneTimer: number | null = null;

function notifyAgentActivity() {
  for (const listener of agentActivityListeners) listener();
}

function pruneExpiredAgentActivities() {
  const now = Date.now();
  let changed = false;
  for (const [id, activity] of agentActivities) {
    const ttl =
      activity.status === "done"
        ? DONE_ACTIVITY_TTL_MS
        : activity.status === "error"
          ? ERROR_ACTIVITY_TTL_MS
          : WORKING_ACTIVITY_STALE_MS;
    if (ttl && now - activity.updatedAt >= ttl) {
      agentActivities.delete(id);
      changed = true;
    }
  }
  if (changed) notifyAgentActivity();
  scheduleAgentActivityPrune();
}

function scheduleAgentActivityPrune() {
  if (agentActivityPruneTimer !== null) {
    window.clearTimeout(agentActivityPruneTimer);
    agentActivityPruneTimer = null;
  }
  let nextDelay = Infinity;
  const now = Date.now();
  for (const activity of agentActivities.values()) {
    const ttl =
      activity.status === "done"
        ? DONE_ACTIVITY_TTL_MS
        : activity.status === "error"
          ? ERROR_ACTIVITY_TTL_MS
          : WORKING_ACTIVITY_STALE_MS;
    if (!ttl) continue;
    nextDelay = Math.min(nextDelay, Math.max(0, ttl - (now - activity.updatedAt)));
  }
  if (Number.isFinite(nextDelay)) {
    agentActivityPruneTimer = window.setTimeout(pruneExpiredAgentActivities, nextDelay + 25);
  }
}

function stripTerminalControls(data: string): string {
  return data
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function detectAgent(text: string): AgentActivity["agent"] | undefined {
  if (CLAUDE_RE.test(text)) return "claude";
  if (CODEX_RE.test(text)) return "codex";
  return undefined;
}

function setAgentActivity(id: string, status: AgentActivityStatus, agent?: AgentActivity["agent"]) {
  const prev = agentActivities.get(id);
  if (agent) agentSessionKinds.set(id, agent);
  const next = {
    status,
    agent: agent ?? prev?.agent,
    updatedAt: Date.now(),
  };
  if (prev && prev.status === next.status && prev.agent === next.agent && Date.now() - prev.updatedAt < 1000) {
    return;
  }
  agentActivities.set(id, next);
  notifyAgentActivity();
  scheduleAgentActivityPrune();
}

function visibleScreenLooksIdle(id: string): boolean {
  const text = sessionVisibleText(id);
  if (!text.trim()) return false;
  const tail = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-4)
    .join("\n");
  return AGENT_IDLE_PROMPT_RE.test(tail) || SHELL_PROMPT_RE.test(tail);
}

function completeAgentActivityIfIdle(id: string) {
  const activity = agentActivities.get(id);
  if (activity?.status === "working" && visibleScreenLooksIdle(id)) {
    setAgentActivity(id, "done", activity.agent);
  }
}

function updateAgentActivityFromOutput(id: string, data: string) {
  const text = stripTerminalControls(data);
  if (!text.trim()) return;
  const prev = agentActivities.get(id);
  const agent = detectAgent(text);
  const isAgentOutput = !!prev || !!agent || AGENT_RE.test(text);
  if (!isAgentOutput) return;

  if (ERROR_RE.test(text) && !BENIGN_ERROR_RE.test(text)) {
    setAgentActivity(id, "error", agent);
    return;
  }
  if (DONE_RE.test(text)) {
    setAgentActivity(id, "done", agent);
    return;
  }
  if (prev?.status === "working" && (ALT_SCREEN_EXIT_RE.test(data) || SHELL_PROMPT_RE.test(text) || AGENT_IDLE_PROMPT_RE.test(text))) {
    setAgentActivity(id, "done", agent);
    return;
  }
  if (!prev || prev.status === "working" || WORKING_RE.test(text)) {
    setAgentActivity(id, "working", agent);
  }
}

function noteAgentInput(id: string, data: string) {
  if (!data.includes("\r")) return;
  const session = sessions.get(id);
  if (!session) return;
  if (agentActivities.has(id) || AGENT_RE.test(sessionVisibleText(id))) {
    setAgentActivity(id, "working");
  }
}

export function subscribeAgentActivity(listener: () => void): () => void {
  agentActivityListeners.add(listener);
  return () => agentActivityListeners.delete(listener);
}

export function agentActivitySnapshot(ids: string[]): string {
  return ids.map((id) => {
    const activity = agentActivities.get(id);
    return activity ? `${id}:${activity.status}:${activity.agent ?? ""}:${activity.updatedAt}` : `${id}:`;
  }).join("|");
}

export function aggregateAgentActivity(ids: string[]): AgentActivity | null {
  let best: AgentActivity | null = null;
  const rank: Record<AgentActivityStatus, number> = { error: 3, working: 2, done: 1 };
  for (const id of ids) {
    const activity = agentActivities.get(id);
    if (!activity) continue;
    if (
      !best ||
      rank[activity.status] > rank[best.status] ||
      (rank[activity.status] === rank[best.status] && activity.updatedAt > best.updatedAt)
    ) {
      best = activity;
    }
  }
  return best;
}

export function agentActivityTitle(activity: AgentActivity): string {
  const who = activity.agent === "claude" ? "Claude" : activity.agent === "codex" ? "Codex" : "Agent";
  if (activity.status === "error") return `${who} reported an error`;
  if (activity.status === "done") return `${who} completed`;
  return `${who} is working`;
}

/**
 * Lines of scrollback xterm keeps in memory per terminal. Sized to hold the
 * server's replayed history tail (SCROLL_CAP raw bytes ≈ a few thousand
 * visible lines) with room for the live session on top — going much higher
 * mostly burns webview memory on lines the history cap can't refill anyway.
 */
const SCROLLBACK_LINES = 5000;

/**
 * History tails from previous runs, keyed by session id, primed once at
 * startup (see scroll.ts). Each is replayed into its terminal the first time
 * that session is created, then dropped so a live session is never overwritten.
 */
const restoreSnapshots = new Map<string, string>();

/** Seed the saved histories before any session is attached (startup only). */
export function primeSnapshots(snapshots: Record<string, string>) {
  for (const [id, data] of Object.entries(snapshots)) {
    if (data) restoreSnapshots.set(id, data);
  }
}

function readScrollState(term: Terminal): TerminalScrollState {
  const buf = term.buffer.active;
  return {
    hasOverflow: buf.baseY > 0,
    atTop: buf.viewportY <= 0,
    atBottom: buf.viewportY >= buf.baseY,
  };
}

function notifyScrollState(id: string) {
  const session = sessions.get(id);
  const listeners = scrollListeners.get(id);
  if (!session || !listeners?.size) return;
  const state = readScrollState(session.term);
  for (const listener of listeners) listener(state);
}

function settleSessionAtBottom(id: string, focus = false) {
  const session = sessions.get(id);
  if (!session) return;
  session.term.scrollToBottom();
  if (focus) session.term.focus();
  // Some terminal UIs redraw prompts via cursor moves/repaints instead of new
  // lines. Let xterm commit the write/render first, then pin the viewport again
  // so "bottom" means the live input area, not the previous scrollback edge.
  requestAnimationFrame(() => {
    const latest = sessions.get(id);
    if (!latest || !latest.followOutput || Date.now() < latest.manualScrollUntil) return;
    latest.term.scrollToBottom();
    latest.term.refresh(0, latest.term.rows - 1);
    notifyScrollState(id);
  });
}

export function subscribeTerminalScrollState(
  id: string,
  listener: (state: TerminalScrollState) => void
): () => void {
  let listeners = scrollListeners.get(id);
  if (!listeners) {
    listeners = new Set();
    scrollListeners.set(id, listeners);
  }
  listeners.add(listener);
  const session = sessions.get(id);
  if (session) listener(readScrollState(session.term));
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) scrollListeners.delete(id);
  };
}

/**
 * The visible screen of every session currently inside the ALTERNATE buffer
 * (fullscreen TUIs: claude, vim, htop…), as plain text — their raw output can't
 * be restored from history because leaving the alt screen discards it. `null`
 * for sessions on the primary screen (their history replay already covers
 * them), which tells the server to clear any stale capture. Sent at quit via
 * the scroll-flush beacon (see scroll.ts).
 */
export function finalScreens(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [id, s] of sessions) {
    if (!s.opened) continue;
    const buf = s.term.buffer.active;
    if (buf.type !== "alternate") {
      out[id] = null;
      continue;
    }
    const lines: string[] = [];
    for (let y = 0; y < s.term.rows; y++) {
      lines.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    out[id] = lines.join("\r\n");
  }
  return out;
}

/**
 * The terminal palette in effect. New sessions are created with it, and
 * applyTermTheme() retints every live session when the user switches themes.
 * Kept here (not in React) because the sessions it paints also live here.
 */
let currentTermTheme: ITheme = {
  background: "#0e1116",
  foreground: "#d7dce2",
  cursor: "#5ccfe6",
  selectionBackground: "#2a3441",
};

const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 32;

function applyTerminalFontSize(id: string, next: number) {
  const session = sessions.get(id);
  if (!session) return;
  const size = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, next));
  if (session.term.options.fontSize === size) return;
  session.term.options.fontSize = size;
  requestAnimationFrame(() => fitSession(id));
}

export function adjustTerminalFontSize(id: string, delta: number) {
  const current = sessions.get(id)?.term.options.fontSize ?? DEFAULT_FONT_SIZE;
  applyTerminalFontSize(id, current + delta);
}

export function resetTerminalFontSize(id: string) {
  applyTerminalFontSize(id, DEFAULT_FONT_SIZE);
}

const IMAGE_MIMES = new Set(["image/gif", "image/jpeg", "image/png", "image/tiff", "image/webp"]);
const IMAGE_UTIS = new Map([
  ["public.jpeg", "image/jpeg"],
  ["public.jpg", "image/jpeg"],
  ["public.png", "image/png"],
  ["public.tiff", "image/tiff"],
  ["org.webmproject.webp", "image/webp"],
]);

function normalizeImageType(value: string): string {
  const type = value.toLowerCase();
  return IMAGE_UTIS.get(type) ?? type;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function readJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function uploadClipboardImage(file: File): Promise<string> {
  const type = normalizeImageType(file.type) || "image/png";
  const res = await fetch(`${apiUrl()}/api/paste-image?type=${encodeURIComponent(type)}`, {
    method: "POST",
    body: file,
  });
  let payload = await readJsonResponse(res);
  if (res.status === 404) {
    const fallback = await fetch(`${apiUrl()}/api/paste-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, data: arrayBufferToBase64(await file.arrayBuffer()) }),
    });
    payload = await readJsonResponse(fallback);
    if (!fallback.ok) throw new Error(payload.error ?? `upload failed (${fallback.status})`);
    return String(payload.path);
  }
  if (!res.ok) throw new Error(payload.error ?? `upload failed (${res.status})`);
  return String(payload.path);
}

function pastedImages(e: ClipboardEvent): File[] {
  const items = Array.from(e.clipboardData?.items ?? []);
  return items
    .filter((item) => IMAGE_MIMES.has(normalizeImageType(item.type)))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

/**
 * IME event tracing, enabled with `?imedebug` in the URL. Logs every
 * keyboard/composition/input event on xterm's hidden textarea plus what xterm
 * actually emits to the PTY, into an on-screen overlay + console. Kept as a
 * diagnostic — WebKit's IME event ordering has bitten us before (see
 * fixWebkitImeDirectInsert) and this pinpoints such bugs in one screenshot.
 */
const IME_DEBUG = new URLSearchParams(location.search).has("imedebug");
let imeLogEl: HTMLDivElement | null = null;
function imeLog(line: string) {
  if (!IME_DEBUG) return;
  if (!imeLogEl) {
    imeLogEl = document.createElement("div");
    imeLogEl.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:9999;max-width:60vw;max-height:45vh;" +
      "overflow:auto;background:rgba(0,0,0,.88);color:#9f9;font:11px/1.5 Menlo,monospace;" +
      "padding:8px 10px;border-radius:6px;pointer-events:none;white-space:pre-wrap;";
    document.body.appendChild(imeLogEl);
  }
  imeLogEl.textContent += line + "\n";
  imeLogEl.scrollTop = imeLogEl.scrollHeight;
  console.log("[ime]", line);
}

function traceImeEvents(term: Terminal) {
  if (!IME_DEBUG || !term.textarea) return;
  const ta = term.textarea;
  const fmt = (v: unknown) => JSON.stringify(v ?? null);
  for (const type of ["keydown", "keypress", "keyup"]) {
    ta.addEventListener(
      type,
      (e) => {
        const k = e as KeyboardEvent;
        imeLog(
          `${type} key=${fmt(k.key)} code=${k.code} keyCode=${k.keyCode} ` +
            `composing=${k.isComposing} ta=${fmt(ta.value)}`
        );
      },
      true
    );
  }
  for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
    ta.addEventListener(
      type,
      (e) => imeLog(`${type} data=${fmt((e as CompositionEvent).data)} ta=${fmt(ta.value)}`),
      true
    );
  }
  for (const type of ["beforeinput", "input"]) {
    ta.addEventListener(
      type,
      (e) => {
        const i = e as InputEvent;
        imeLog(
          `${type} inputType=${i.inputType} data=${fmt(i.data)} ` +
            `composing=${i.isComposing} ta=${fmt(ta.value)}`
        );
      },
      true
    );
  }
  ta.addEventListener("focus", () => imeLog("focus"), true);
  ta.addEventListener("blur", () => imeLog("blur"), true);
}

/** Switch the terminal palette: future sessions + all currently open ones. */
export function applyTermTheme(theme: ITheme) {
  currentTermTheme = theme;
  for (const s of sessions.values()) s.term.options.theme = theme;
}

function getSession(id: string, cwdFrom?: string[]): Session {
  const existing = sessions.get(id);
  if (existing) return existing;

  const el = document.createElement("div");
  el.className = "term-host";

  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize: DEFAULT_FONT_SIZE,
    scrollback: SCROLLBACK_LINES,
    cursorBlink: true,
    allowProposedApi: true,
    // Lets art-forward themes use an rgba() terminal background so the window
    // artwork shows through the pane veil; opaque themes render identically.
    allowTransparency: true,
    theme: currentTermTheme,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);

  const search = new SearchAddon();
  term.loadAddon(search);

  // xterm swallows every keydown it decides to handle (preventDefault +
  // stopPropagation) before it can bubble up to App.tsx's window-level
  // shortcut listener — so with a terminal focused (the common case, since
  // typing IS the terminal), app shortcuts like ⌘W silently did nothing.
  // Step aside for any key that matches a live user shortcut binding so it
  // reaches the app instead of being typed into the shell.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const keybindings = loadKeybindings();
    for (const action of ACTIONS) {
      if (matchChord(event, keybindings[action.id] ?? action.default)) return false;
    }
    return true;
  });

  // Replay the previous run's output tail (server-captured, sanitized) ABOVE
  // the fresh shell, so a reopened pane shows where it left off. The raw replay
  // can leave the emulator in a mode the dead shell set (alt screen, mouse
  // reporting, scroll margins, hidden cursor, line-drawing charset…), so
  // neutralise all of that before drawing the divider. Two hard-won subtleties:
  //  - `?1049l` is sent ONLY if the replay actually ended inside the alternate
  //    screen: on the normal screen it performs a cursor RESTORE to a stale
  //    saved position, teleporting the cursor up into the restored content —
  //    which the new shell's erase-below then wipes out.
  //  - The reset runs in write-callbacks (async), so the new shell's first
  //    output is held in `pendingOutput` until the divider is down; otherwise
  //    it could interleave into the middle of the reset sequence.
  const pendingOutput: string[] = [];
  let replaying = false;
  const snapshot = restoreSnapshots.get(id);
  if (snapshot) {
    restoreSnapshots.delete(id);
    replaying = true;
    term.write(snapshot, () => {
      const finishReset = () => {
        const row = term.buffer.active.cursorY + 1; // where the replay ended
        term.write(
          "\x1b[r\x1b[?1000;1002;1003;1006l\x1b[?1004l\x1b[?2004l\x1b[?6l\x1b[?7h" +
            "\x1b[?25h\x1b(B\x0f\x1b[0m" +
            `\x1b[${row};1H\x1b7` + // re-park at the content end; overwrite stale saved-cursor
            "\r\n", // no divider — history flows straight into the new shell
          () => {
            replaying = false;
            for (const d of pendingOutput.splice(0)) term.write(d);
          }
        );
      };
      if (term.buffer.active.type === "alternate") term.write("\x1b[?1049l", finishReset);
      else finishReset();
    });
  }

  // Make URLs open on Cmd+click. The custom provider also joins links hard-
  // wrapped by rich CLI output, which xterm's stock addon cannot do.
  registerWebLinks(term);
  // Local file paths (including relative ones like `src/foo.ts`) are verified
  // and resolved by the server against this shell's live cwd. If the server
  // can't answer (demo mode, old server), fall back to trusting absolute
  // paths unverified so links don't disappear entirely.
  registerLocalPathLinks(term, async (paths) => {
    const fallback = () => paths.map((p) => (/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(p) ? p : null));
    if (isDemo) return fallback();
    try {
      const res = await fetch(`${apiUrl()}/api/resolve-paths`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: id, paths }),
      });
      if (!res.ok) return fallback();
      const payload = await readJsonResponse(res);
      return Array.isArray(payload.resolved) ? payload.resolved : fallback();
    } catch {
      return fallback();
    }
  });

  // Reconnecting with the same session id spawns a fresh shell server-side
  // once the old one has exited (see apps/server's ptySessions registry) —
  // so "restart" just means opening a new backend for the same id.
  const spawnBackend = (): ITerminalBackend =>
    isDemo
      ? new DemoBackend(id)
      : new WebSocketBackend(WS_URL, { session: id, cwdFrom: cwdFrom?.length ? cwdFrom.join(",") : undefined });

  const initialBackend = spawnBackend();
  const session: Session = {
    el,
    term,
    fit,
    search,
    backend: initialBackend,
    opened: false,
    followOutput: true,
    manualScrollUntil: 0,
    deferredOutput: [],
    deferredSince: 0,
    deferredFlushTimer: null,
    spawnedAt: Date.now(),
    restartAttempts: 0,
  };
  sessions.set(id, session);

  const wireBackend = (b: ITerminalBackend) => {
    b.onData((data) => {
      updateAgentActivityFromOutput(id, data);
      if (replaying) {
        pendingOutput.push(data);
        return;
      }
      writeSessionData(id, data);
    });
    b.onExit((reason) => {
      if (agentActivities.has(id)) setAgentActivity(id, reason ? "error" : "done");
      // A truthy reason means the WebSocket itself couldn't connect, which
      // already exhausted its own retry budget (see WebSocketBackend) before
      // giving up — not worth immediately repeating that losing battle. Only
      // a natural shell exit (no reason) is auto-respawned.
      if (reason) {
        term.write(`\r\n\x1b[2m[session ended: ${reason}]\x1b[0m\r\n`);
        return;
      }
      if (Date.now() - session.spawnedAt > RESTART_HEALTHY_MS) session.restartAttempts = 0;
      if (session.restartAttempts >= MAX_AUTO_RESTARTS) {
        term.write(`\r\n\x1b[2m[session ended]\x1b[0m\r\n`);
        return;
      }
      session.restartAttempts++;
      term.write(`\r\n\x1b[2m[session ended — starting a new shell]\x1b[0m\r\n`);
      const next = spawnBackend();
      session.backend = next;
      session.spawnedAt = Date.now();
      wireBackend(next);
    });
  };
  wireBackend(initialBackend);

  term.onData((data) => {
    if (IME_DEBUG) imeLog(`→PTY ${JSON.stringify(data)}`);
    noteAgentInput(id, data);
    session.backend.write(data);
  });

  // Select-to-copy: when the mouse is released over a non-empty selection, copy
  // it to the clipboard (iTerm/Terminal.app behaviour). The selection stays put.
  el.addEventListener("mouseup", () => {
    const sel = term.getSelection();
    if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
  });

  // Paste image blobs as local file paths only when the active program looks
  // like an agent/TUI that knows how to turn image paths into image chips.
  // In a plain shell, inserting the temp path directly is surprising and easy
  // to submit accidentally.
  // Duplicate-fire guard: swallow a second image paste while one is still
  // uploading or within a short cooldown — key auto-repeat on a held ⌘V (and
  // any double-dispatched event) otherwise inserts the same screenshot twice.
  let imagePasteBusyUntil = 0;
  el.addEventListener(
    "paste",
    (e) => {
      if (isDemo) return; // no upload endpoint — let text paste through, drop images
      const images = pastedImages(e);
      if (!images.length) return;
      e.preventDefault();
      // Also stop xterm's own paste handler (it ignores defaultPrevented and
      // pastes any text/plain flavor riding along with the image — e.g. the
      // source file path when copying from WeChat/Preview/browsers — which
      // otherwise lands in the prompt as a SECOND image reference).
      e.stopPropagation();
      if (Date.now() < imagePasteBusyUntil) return;
      imagePasteBusyUntil = Date.now() + 1000;
      void (async () => {
        const settled = await Promise.allSettled(images.map(uploadClipboardImage));
        const paths = settled
          .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
          .map((result) => result.value);
        // Deliver through xterm's paste pipeline, NOT as raw keystrokes: apps
        // with bracketed paste on (claude, codex, vim, modern shells) then
        // receive ONE paste event. Agent CLIs can recognize pasted image paths
        // and render [Image #N] chips instead of echoing raw temp paths.
        if (paths.length) {
          if (sessionLooksLikeAgentInput(id)) {
            term.paste(`${paths.join(" ")} `);
          } else {
            term.write(
              `\r\n\x1b[2m[termany] image saved: ${paths.join(" ")} — no agent prompt detected here, so the path was not inserted.\x1b[0m\r\n`
            );
          }
        }
        if (!paths.length) {
          const reason = settled.find(
            (result): result is PromiseRejectedResult => result.status === "rejected"
          )?.reason;
          const msg = reason instanceof Error ? reason.message : String(reason ?? "unknown error");
          term.write(`\r\n\x1b[31m[termany] failed to paste image: ${msg}\x1b[0m\r\n`);
        }
      })();
    },
    true
  );

  return session;
}

/**
 * WKWebView/Safari IME fix: SHIFTED full-width punctuation from a CJK IME
 * (？ ： etc.) arrives as keydown keyCode 229 + an `insertText` input event,
 * with NO composition events. xterm's 229 fallback snapshots the textarea on
 * keydown and diffs it a tick later — on WebKit that diff runs one keystroke
 * LATE, so each press shows the PREVIOUS character ("press twice to type").
 * Catch exactly that shape ourselves: forward the inserted text and clear the
 * textarea so xterm's late diff finds nothing to (re)send. Unshifted marks
 * (，。) use real keycodes and normal pinyin uses composition events — both
 * are skipped here and keep working through xterm's own paths.
 */
function fixWebkitImeDirectInsert(term: Terminal) {
  const ua = navigator.userAgent;
  const isPureWebKit = ua.includes("AppleWebKit") && !/Chrome|Chromium|Edg\//.test(ua);
  if (!isPureWebKit || !term.textarea) return;
  const ta = term.textarea;
  const MODIFIERS = new Set([16, 17, 18, 91, 93]); // shift ctrl alt meta(L/R)
  let composing = false;
  let compositionEndedAt = 0;
  let lastRealKeydownAt = 0; // any non-modifier, non-229 keydown

  ta.addEventListener(
    "keydown",
    (e) => {
      if (e.keyCode !== 229 && !MODIFIERS.has(e.keyCode)) lastRealKeydownAt = performance.now();
    },
    true
  );
  ta.addEventListener("compositionstart", () => (composing = true), true);
  ta.addEventListener(
    "compositionend",
    () => {
      composing = false;
      compositionEndedAt = performance.now();
    },
    true
  );
  // Intercept at BEFOREINPUT — it precedes xterm's own `input` listener, so
  // cancelling here means the character never reaches the textarea and xterm
  // never sees an input event: exactly one copy goes to the PTY, ours.
  ta.addEventListener(
    "beforeinput",
    (e) => {
      const ev = e as InputEvent;
      if (ev.inputType !== "insertText" || !ev.data) return; // compositions, paste, deletes…
      if (composing || ev.isComposing || performance.now() - compositionEndedAt < 150) {
        imeLog("fix:skip composition window");
        return;
      }
      // A normal keystroke's keydown → beforeinput chain is sub-millisecond.
      // An IME direct insert has NO real keydown before it (WebKit delivers
      // its keyCode-229 keydown AFTER the input events), so any gap means IME.
      if (performance.now() - lastRealKeydownAt < 30) {
        imeLog(`fix:skip normal-typing ${JSON.stringify(ev.data)}`);
        return;
      }
      ev.preventDefault();
      imeLog(`fix:SEND ${JSON.stringify(ev.data)}`);
      term.input(ev.data, true);
    },
    true
  );
}

/**
 * macOS IME fix: switching input source mid-composition (e.g. Pinyin → ABC,
 * often bound to a bare Shift press) abandons the pending syllable without
 * reliably firing `compositionend` first. xterm's CompositionHelper is left
 * thinking composition is still open, so when the very next ordinary keydown
 * arrives (the first English letter typed after the switch), it "finalizes"
 * the stale composition immediately — see CompositionHelper.keydown(), which
 * flushes `textarea.value.substring(start, end)` straight to the PTY. On
 * WebKit that leftover slice is often just a bare space (macOS's TSM commits
 * an empty marked-text run as one space rather than nothing), which lands in
 * the shell as a real, untyped character — Backspace looks broken because the
 * cursor position the user expects and the one the phantom char sits at have
 * already diverged by the time they notice it.
 *
 * xterm's own comment on that immediate-finalize branch says it exists
 * "mainly... for the case where enter is pressed" (commit before the command
 * runs) — so any OTHER real key hitting that branch while still marked as
 * composing is the abandoned-composition bug, not a legitimate flow. Wipe the
 * textarea just before xterm reads it so the flush sends nothing instead of
 * the stale leftover. Registered on `document` (an ancestor of the textarea)
 * so it runs before xterm's own capture-phase listener on the textarea
 * itself — capture-phase listeners on ancestors always run first, regardless
 * of attach order.
 */
function fixAbandonedImeFinalize(term: Terminal) {
  const ua = navigator.userAgent;
  const isPureWebKit = ua.includes("AppleWebKit") && !/Chrome|Chromium|Edg\//.test(ua);
  if (!isPureWebKit || !term.textarea) return;
  const ta = term.textarea;
  const MODIFIERS = new Set([16, 17, 18, 91, 93]); // shift ctrl alt meta(L/R)
  let composing = false;

  ta.addEventListener("compositionstart", () => (composing = true), true);
  ta.addEventListener("compositionend", () => (composing = false), true);

  document.addEventListener(
    "keydown",
    (e) => {
      if (!composing || e.target !== ta) return;
      composing = false;
      if (e.keyCode === 229 || MODIFIERS.has(e.keyCode) || e.key === "Enter") return;
      imeLog(`fix:drop-abandoned-composition before ${JSON.stringify(e.key)} ta=${JSON.stringify(ta.value)}`);
      ta.value = "";
    },
    true
  );
}

/** Attach the session's element into `host` and open the terminal (once). */
export function attachSession(id: string, host: HTMLElement, cwdFrom?: string[]) {
  const s = getSession(id, cwdFrom);
  host.appendChild(s.el);
  if (!s.opened) {
    s.term.open(s.el); // el is now in the document — renderer initialises correctly
    // GPU renderer: the default DOM renderer repaints character-by-character and
    // makes echo feel laggy. WebGL must be loaded AFTER open(). If the GPU context
    // is lost (driver reset / tab backgrounded), dispose so xterm falls back to DOM.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      s.term.loadAddon(webgl);
    } catch {
      /* no WebGL available — DOM renderer still works */
    }
    fixWebkitImeDirectInsert(s.term);
    fixAbandonedImeFinalize(s.term);
    traceImeEvents(s.term);
    s.term.onScroll(() => {
      const scrollState = readScrollState(s.term);
      s.followOutput = scrollState.atBottom;
      notifyScrollState(id);
    });
    s.opened = true;
  }
  fitSession(id);
  focusSession(id);
  const queued = pendingCommands.get(id);
  if (queued?.length) {
    pendingCommands.delete(id);
    window.setTimeout(() => {
      for (const command of queued) sendCommand(id, command);
    }, 50);
  }
}

export function scrollSessionToTop(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  session.followOutput = false;
  session.term.scrollToTop();
  notifyScrollState(id);
}

export function scrollSessionToBottom(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  session.followOutput = true;
  settleSessionAtBottom(id, true);
}

/** Detach from the DOM but keep the session (and its shell) alive. */
export function detachSession(id: string, host: HTMLElement) {
  const s = sessions.get(id);
  if (s && s.el.parentNode === host) host.removeChild(s.el);
}

/** Refit to the current container size and tell the PTY the new dimensions. */
export function fitSession(id: string) {
  const s = sessions.get(id);
  if (!s || !s.opened) return;
  try {
    s.fit.fit();
    s.backend.resize(s.term.cols, s.term.rows);
  } catch {
    /* container not laid out yet */
  }
}

export function focusSession(id: string) {
  // In the landing-page demo iframe, programmatic focus on load would steal
  // the visitor's keyboard/scroll — hold off until they click into the demo.
  if (isDemo && !demoInteracted()) return;
  sessions.get(id)?.term.focus();
}

/**
 * Clear the screen (⌘K) by sending Ctrl+L (0x0c) to the PTY, the same as a
 * real terminal — NOT `term.clear()`. That call unilaterally keeps only the
 * cursor's current row and discards the rest of xterm's buffer, which desyncs
 * any program that tracks its own layout for relative-cursor redraws (shells'
 * multi-line prompts, and especially full-screen-ish TUIs like claude/codex
 * that repaint via "move cursor up N, erase, redraw" — see incident where
 * this broke mid-conversation rendering). Ctrl+L instead asks whatever's
 * actually running to redraw itself, so it can never get out of sync with
 * what's really on screen: readline's clear-screen for a plain shell, or the
 * TUI's own repaint if one is in front.
 */
export function clearSession(id: string) {
  sessions.get(id)?.backend.write("\x0c");
}

/**
 * Scrollback search (⌘F). Highlights every hit and moves the viewport to one
 * of them; `dir` picks which way the next match is taken from the current one.
 * Returns whether anything matched, so the find bar can flag a dead query.
 */
const SEARCH_DECORATIONS = {
  matchOverviewRuler: "#f2c94c",
  activeMatchColorOverviewRuler: "#f2994a",
  matchBackground: "#5a4a1f",
  activeMatchBackground: "#a06a12",
};

// Remembered so ⌘G / ⌘⇧G can step through the previous query with the find
// bar closed — the same "find next without reopening find" every editor has.
let lastQuery = "";

export function findInSession(id: string, term: string, dir: "next" | "prev" = "next"): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (!term) {
    s.search.clearDecorations();
    return true;
  }
  lastQuery = term;
  const opts = { decorations: SEARCH_DECORATIONS, regex: false, caseSensitive: false };
  return dir === "next" ? s.search.findNext(term, opts) : s.search.findPrevious(term, opts);
}

/** Step through the last query again (⌘G / ⌘⇧G). No-op if nothing searched yet. */
export function repeatFind(id: string, dir: "next" | "prev"): boolean {
  return lastQuery ? findInSession(id, lastQuery, dir) : false;
}

/** Drop search highlighting — called when the find bar closes. */
export function clearSessionSearch(id: string) {
  sessions.get(id)?.search.clearDecorations();
}

/**
 * Subscribe to match counts for the find bar's "3/17" readout. xterm reports
 * -1 for both while a large buffer is still being scanned.
 */
export function onSearchResults(
  id: string,
  cb: (r: { index: number; count: number }) => void
): () => void {
  const s = sessions.get(id);
  if (!s) return () => {};
  const sub = s.search.onDidChangeResults((r) => cb({ index: r.resultIndex, count: r.resultCount }));
  return () => sub.dispose();
}

/**
 * Type a command into the session's shell and press Enter, as if the user
 * had. Used to `cd` an existing terminal to wherever the file tree navigated
 * to when switching back from it — a no-op (and safe) if `id` has no live
 * session yet, same as clearSession above.
 */
export function sendCommand(id: string, command: string) {
  const agent = AGENT_COMMAND_RE.exec(command)?.[1]?.toLowerCase() as AgentActivity["agent"] | undefined;
  if (agent) setAgentActivity(id, "working", agent);
  sessions.get(id)?.backend.write(`${command}\r`);
}

export function queueCommand(id: string, command: string) {
  if (sessions.has(id)) {
    sendCommand(id, command);
    return;
  }
  pendingCommands.set(id, [...(pendingCommands.get(id) ?? []), command]);
}

/** Insert text at the cursor via xterm's paste pipeline — same path clipboard
 *  image paste uses (see the `paste` listener above), so apps with bracketed
 *  paste on (vim, claude, modern shells) see it as one paste, not typed
 *  keystrokes. Used for dropping a file/folder from Finder onto the pane. */
export function pasteIntoSession(id: string, text: string) {
  sessions.get(id)?.term.paste(text);
}

export function sessionUsesAlternateBuffer(id: string): boolean {
  return sessions.get(id)?.term.buffer.active.type === "alternate";
}

export function sessionLooksLikeAgentInput(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.term.buffer.active.type === "alternate") return true;
  const visible = sessionVisibleText(id);
  if (AGENT_RE.test(visible)) return true;
  return agentSessionKinds.has(id) && agentInputPromptVisible(visible);
}

/**
 * Does the visible screen show an agent's input line?
 *
 * Scans the last few NON-EMPTY rows (the same shape as visibleScreenLooksIdle)
 * instead of anchoring to the end of the text. An agent CLI wraps its input in
 * a box and parks a bottom border plus a hint line under it, so the prompt is
 * almost never the final character of the screen — an end-anchored match found
 * it only in the degenerate case, which is why pasting an image at a Codex
 * prompt fell through to the "no agent prompt" branch.
 */
function agentInputPromptVisible(visible: string): boolean {
  const rows = visible
    .split("\n")
    .map((line) => line.replace(BOX_CHROME_RE, ""))
    .filter(Boolean);
  return rows.slice(-AGENT_PROMPT_SCAN_ROWS).some((row) => AGENT_INPUT_PROMPT_RE.test(row));
}

function sessionVisibleText(id: string): string {
  const session = sessions.get(id);
  if (!session) return "";
  const buf = session.term.buffer.active;
  const start = Math.max(0, buf.viewportY);
  const end = Math.min(buf.length, start + session.term.rows);
  const lines: string[] = [];
  for (let y = start; y < end; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

/** Permanently destroy a session — only when the user closes the pane/tab. */
export function disposeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  s.backend.dispose();
  s.term.dispose();
  s.el.remove();
  sessions.delete(id);
  if (agentActivities.delete(id)) notifyAgentActivity();
  agentSessionKinds.delete(id);
  restoreSnapshots.delete(id);
  if (isDemo) return;
  // Drop its persisted restore data — a closed pane should not come back.
  fetch(`${apiUrl()}/api/forget`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  }).catch(() => {});
}
