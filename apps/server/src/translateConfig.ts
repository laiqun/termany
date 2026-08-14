import { getMeta, setMeta } from "./db.js";
import type { EngineId } from "./translate.js";

/**
 * Translate-engine configuration for the selection lookup bubble, persisted
 * in the local SQLite DB next to the model providers (see db.ts/config.ts).
 *
 * google is off by default: it is unreachable from some networks (mainland
 * China), and an enabled-but-blocked engine would still cost a timeout on
 * every first lookup. caiyun needs a free token the user registers at
 * fanyi.caiyunapp.com; it stays skipped until one is set.
 */

export interface TranslateConfig {
  enabled: EngineId[];
  /** Full token (server-side only). Never returned by listTranslateConfig(). */
  caiyunToken: string;
}

const ENGINE_IDS: EngineId[] = ["youdao", "baidu", "caiyun", "google"];
const DEFAULT_ENABLED: EngineId[] = ["youdao", "baidu", "caiyun"];

const META_KEY = "translateConfig";

export function loadTranslateConfig(): TranslateConfig {
  try {
    const raw = JSON.parse(getMeta(META_KEY) ?? "{}");
    const enabled = (Array.isArray(raw.enabled) ? raw.enabled : DEFAULT_ENABLED).filter(
      (id: unknown): id is EngineId => ENGINE_IDS.includes(id as EngineId)
    );
    return {
      enabled: enabled.length ? enabled : DEFAULT_ENABLED,
      caiyunToken: typeof raw.caiyunToken === "string" ? raw.caiyunToken : "",
    };
  } catch {
    return { enabled: DEFAULT_ENABLED, caiyunToken: "" };
  }
}

function maskToken(token: string): string {
  if (!token) return "";
  return "•".repeat(Math.max(0, token.length - 4)).slice(0, 8) + token.slice(-4);
}

/** Public config for the browser: token masked, never sent in the clear. */
export function listTranslateConfig() {
  const cfg = loadTranslateConfig();
  return {
    enabled: cfg.enabled,
    caiyunTokenMask: maskToken(cfg.caiyunToken),
    hasCaiyunToken: !!cfg.caiyunToken,
  };
}

const MASK_RE = /[•*]/;

/**
 * Persist engine selection + caiyun token. An incoming token that's empty or
 * still masked means "unchanged" — we keep the stored one.
 */
export function saveTranslateConfig(input: {
  enabled?: unknown;
  caiyunToken?: string;
}): TranslateConfig {
  const prior = loadTranslateConfig();
  const enabled = Array.isArray(input.enabled)
    ? input.enabled.filter((id): id is EngineId => ENGINE_IDS.includes(id as EngineId))
    : prior.enabled;
  const incoming = input.caiyunToken ?? "";
  const caiyunToken = incoming === "" || MASK_RE.test(incoming) ? prior.caiyunToken : incoming;

  setMeta(META_KEY, JSON.stringify({ enabled, caiyunToken }));
  return loadTranslateConfig();
}
