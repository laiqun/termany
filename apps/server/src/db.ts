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
