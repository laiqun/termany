import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Model-provider configuration, persisted to ~/.termany/models.json.
 *
 * Keys live here (server-side) — they're used to call provider APIs and are
 * never sent to the browser in the clear (GET masks them). One built-in
 * "Anthropic" provider is always present; it's "managed" (uses the server's
 * ANTHROPIC_API_KEY env var) and can't be edited or deleted.
 */

export type ProviderKind = "anthropic" | "openai";

export interface Provider {
  id: string;
  name: string;
  /** Base URL, e.g. https://api.deepseek.com. Empty for the managed built-in. */
  apiBase: string;
  /** Full key (file only). Never returned by listConfig(). */
  apiKey: string;
  models: string[];
  kind: ProviderKind;
  /** Built-in providers are managed (env key) and read-only. */
  builtin?: boolean;
}

export interface ModelsConfig {
  providers: Provider[];
  /** "providerId/modelName" */
  defaultModel: string;
}

const FILE = path.join(os.homedir(), ".termany", "models.json");

const BUILT_IN: Provider = {
  id: "anthropic",
  name: "Anthropic",
  apiBase: "",
  apiKey: "",
  models: ["claude-opus-4-8"],
  kind: "anthropic",
  builtin: true,
};

function readFile(): { providers: Provider[]; defaultModel: string } {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    return {
      providers: Array.isArray(raw.providers) ? raw.providers : [],
      defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : "",
    };
  } catch {
    return { providers: [], defaultModel: "" };
  }
}

/** Full config including the managed built-in and real keys (server-internal). */
export function loadConfig(): ModelsConfig {
  const { providers, defaultModel } = readFile();
  const custom = providers.filter((p) => !p.builtin && p.id !== BUILT_IN.id);
  const all = [BUILT_IN, ...custom];
  const valid = all.some((p) => p.models.some((m) => `${p.id}/${m}` === defaultModel));
  return {
    providers: all,
    defaultModel: valid ? defaultModel : `${BUILT_IN.id}/${BUILT_IN.models[0]}`,
  };
}

function maskKey(key: string): string {
  if (!key) return "";
  return "•".repeat(Math.max(0, key.length - 4)).slice(0, 8) + key.slice(-4);
}

/** Public config for the browser: built-in flagged managed, custom keys masked. */
export function listConfig() {
  const cfg = loadConfig();
  return {
    defaultModel: cfg.defaultModel,
    providers: cfg.providers.map((p) => ({
      id: p.id,
      name: p.name,
      apiBase: p.apiBase,
      models: p.models,
      kind: p.kind,
      builtin: !!p.builtin,
      managed: !!p.builtin,
      keyMask: p.builtin ? "" : maskKey(p.apiKey),
      hasKey: p.builtin ? !!process.env.ANTHROPIC_API_KEY : !!p.apiKey,
    })),
  };
}

const MASK_RE = /[•*]/;

/**
 * Persist incoming custom providers + default selection. An incoming apiKey
 * that's empty or still masked means "unchanged" — we keep the stored key.
 */
export function saveConfig(input: {
  providers: Array<Partial<Provider>>;
  defaultModel: string;
}): ModelsConfig {
  const existing = new Map(readFile().providers.map((p) => [p.id, p]));

  const custom: Provider[] = (input.providers ?? [])
    .filter((p) => p.id && p.id !== BUILT_IN.id && !p.builtin)
    .map((p) => {
      const prior = existing.get(p.id!);
      const incomingKey = p.apiKey ?? "";
      const keepOld = prior && (incomingKey === "" || MASK_RE.test(incomingKey));
      return {
        id: p.id!,
        name: (p.name ?? "").trim() || "Provider",
        apiBase: (p.apiBase ?? "").trim().replace(/\/+$/, ""),
        apiKey: keepOld ? prior!.apiKey : incomingKey,
        models: (p.models ?? []).map((m) => m.trim()).filter(Boolean),
        kind: "openai",
      };
    });

  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ providers: custom, defaultModel: input.defaultModel }, null, 2));
  return loadConfig();
}
