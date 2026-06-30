import { getModelsRaw, setModelsRaw } from "./db.js";

/**
 * Model-provider configuration, persisted in the local SQLite DB (see db.ts).
 *
 * BYOK (bring your own key): there is no managed/built-in provider. The user
 * adds their own providers — Anthropic or any OpenAI-compatible endpoint — with
 * their own API key. Keys live here (server-side) and are masked on read.
 */

export type ProviderKind = "anthropic" | "openai";

export interface Provider {
  id: string;
  name: string;
  /** Base URL. Empty for Anthropic = the official api.anthropic.com endpoint. */
  apiBase: string;
  /** Full key (file only). Never returned by listConfig(). */
  apiKey: string;
  models: string[];
  kind: ProviderKind;
}

export interface ModelsConfig {
  providers: Provider[];
  /** "providerId/modelName" */
  defaultModel: string;
}

function readFile(): ModelsConfig {
  try {
    const raw = JSON.parse(getModelsRaw() ?? "{}");
    return {
      providers: Array.isArray(raw.providers) ? raw.providers : [],
      defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : "",
    };
  } catch {
    return { providers: [], defaultModel: "" };
  }
}

/** Full config including real keys (server-internal). */
export function loadConfig(): ModelsConfig {
  const { providers, defaultModel } = readFile();
  const all = providers.flatMap((p) => p.models.map((m) => `${p.id}/${m}`));
  const valid = all.includes(defaultModel);
  // If the saved default is gone, fall back to the first available model (or none).
  return { providers, defaultModel: valid ? defaultModel : all[0] ?? "" };
}

function maskKey(key: string): string {
  if (!key) return "";
  return "•".repeat(Math.max(0, key.length - 4)).slice(0, 8) + key.slice(-4);
}

/** Public config for the browser: keys masked, never sent in the clear. */
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
      keyMask: maskKey(p.apiKey),
      hasKey: !!p.apiKey,
    })),
  };
}

const MASK_RE = /[•*]/;

/**
 * Persist providers + default selection. An incoming apiKey that's empty or
 * still masked means "unchanged" — we keep the stored key.
 */
export function saveConfig(input: {
  providers: Array<Partial<Provider>>;
  defaultModel: string;
}): ModelsConfig {
  const existing = new Map(readFile().providers.map((p) => [p.id, p]));

  const providers: Provider[] = (input.providers ?? [])
    .filter((p) => p.id)
    .map((p) => {
      const prior = existing.get(p.id!);
      const incomingKey = p.apiKey ?? "";
      const keepOld = prior && (incomingKey === "" || MASK_RE.test(incomingKey));
      const kind: ProviderKind = p.kind === "anthropic" ? "anthropic" : "openai";
      return {
        id: p.id!,
        name: (p.name ?? "").trim() || "Provider",
        apiBase: (p.apiBase ?? "").trim().replace(/\/+$/, ""),
        apiKey: keepOld ? prior!.apiKey : incomingKey,
        models: (p.models ?? []).map((m) => m.trim()).filter(Boolean),
        kind,
      };
    });

  setModelsRaw(JSON.stringify({ providers, defaultModel: input.defaultModel }));
  return loadConfig();
}
