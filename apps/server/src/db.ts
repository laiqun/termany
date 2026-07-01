import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Local store, SQLite — the same shape Wave/Warp use: the backend owns a single
 * .db as the source of truth (not the webview's localStorage). One row per
 * workspace (so a workspace stays the unit we can later sync/share), plus a
 * small key/value table for app meta and the BYOK model config.
 *
 * ~/.termany/termany.db
 */

const DIR = path.join(os.homedir(), ".termany");
mkdirSync(DIR, { recursive: true });

const db = new DatabaseSync(path.join(DIR, "termany.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS session_cwd (id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS session_scroll (id TEXT PRIMARY KEY, data TEXT NOT NULL);
`);

export function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setMeta(key: string, value: string): void {
  db.prepare(
    "INSERT INTO app_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

// One-time import of the legacy ~/.termany/models.json into the DB.
if (getMeta("models") === null) {
  const legacy = path.join(DIR, "models.json");
  if (existsSync(legacy)) {
    try {
      setMeta("models", readFileSync(legacy, "utf8"));
    } catch {
      /* ignore a malformed legacy file */
    }
  }
}

export function getModelsRaw(): string | null {
  return getMeta("models");
}
export function setModelsRaw(json: string): void {
  setMeta("models", json);
}

// --- workspace layout ------------------------------------------------------

export interface AppState {
  workspaces: unknown[];
  activeWorkspace: string;
  sidebarCollapsed: boolean;
}

export function loadState(): AppState {
  const rows = db.prepare("SELECT data FROM workspace ORDER BY pos").all() as { data: string }[];
  return {
    workspaces: rows.map((r) => JSON.parse(r.data)),
    activeWorkspace: getMeta("activeWorkspace") ?? "",
    sidebarCollapsed: getMeta("sidebarCollapsed") === "1",
  };
}

export function saveState(state: AppState): void {
  const workspaces = Array.isArray(state.workspaces) ? state.workspaces : [];
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM workspace");
    const ins = db.prepare("INSERT INTO workspace(id, pos, data) VALUES(?, ?, ?)");
    workspaces.forEach((w: any, i) => ins.run(String(w?.id ?? i), i, JSON.stringify(w)));
    setMeta("activeWorkspace", String(state.activeWorkspace ?? ""));
    setMeta("sidebarCollapsed", state.sidebarCollapsed ? "1" : "0");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// --- per-session restore data (cwd + scrollback snapshot) ------------------
// Keyed by the frontend's stable pane/session id, which the layout persists, so
// a respawned shell can land in its old directory and replay its last screen.

export function getSessionCwd(id: string): string | null {
  const row = db.prepare("SELECT cwd FROM session_cwd WHERE id = ?").get(id) as
    | { cwd: string }
    | undefined;
  return row ? row.cwd : null;
}

export function setSessionCwd(id: string, cwd: string): void {
  db.prepare(
    "INSERT INTO session_cwd(id, cwd) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd"
  ).run(id, cwd);
}

/** All saved scrollback snapshots, as an `{ id: data }` map — for startup prime. */
export function getAllScroll(): Record<string, string> {
  const rows = db.prepare("SELECT id, data FROM session_scroll").all() as {
    id: string;
    data: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.data]));
}

/** Upsert a batch of scrollback snapshots in one transaction. */
export function setScrollBatch(snapshots: Record<string, string>): void {
  const entries = Object.entries(snapshots ?? {});
  if (!entries.length) return;
  db.exec("BEGIN");
  try {
    const ins = db.prepare(
      "INSERT INTO session_scroll(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data"
    );
    for (const [id, data] of entries) ins.run(String(id), String(data ?? ""));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Drop all restore data for sessions the user has permanently closed. */
export function forgetSessions(ids: string[]): void {
  if (!Array.isArray(ids) || !ids.length) return;
  db.exec("BEGIN");
  try {
    const delCwd = db.prepare("DELETE FROM session_cwd WHERE id = ?");
    const delScroll = db.prepare("DELETE FROM session_scroll WHERE id = ?");
    for (const id of ids) {
      delCwd.run(String(id));
      delScroll.run(String(id));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
