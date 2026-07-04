import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type Provider } from "./config.js";

/**
 * AI theme generation. Runs server-side so provider API keys never reach the
 * browser. Uses whatever provider/model is set as the default in model settings
 * (see config.ts) — the managed Anthropic built-in, or any custom
 * OpenAI-compatible provider (DeepSeek, etc.).
 *
 * The output matches the frontend Theme schema (apps/web/src/themes/types.ts).
 */

const COLOR = { type: "string" } as const;

const THEME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Short display name, 1-3 words" },
    appearance: { type: "string", enum: ["dark", "light"] },
    colors: {
      type: "object",
      additionalProperties: false,
      properties: {
        bg: COLOR,
        bg2: COLOR,
        bg3: COLOR,
        border: COLOR,
        fg: COLOR,
        fgDim: COLOR,
        accent: COLOR,
        accentSoft: COLOR,
      },
      required: ["bg", "bg2", "bg3", "border", "fg", "fgDim", "accent", "accentSoft"],
    },
    radius: {
      type: "object",
      additionalProperties: false,
      properties: { sm: { type: "string" }, md: { type: "string" }, lg: { type: "string" } },
      required: ["sm", "md", "lg"],
    },
    term: {
      type: "object",
      additionalProperties: false,
      properties: {
        background: COLOR,
        foreground: COLOR,
        cursor: COLOR,
        selectionBackground: COLOR,
      },
      required: ["background", "foreground", "cursor", "selectionBackground"],
    },
  },
  required: ["name", "appearance", "colors", "radius", "term"],
} as const;

const SYSTEM = `You design color themes for a terminal app. Given a short brief, return one cohesive theme.

Rules:
- colors.bg is the terminal background; bg2 is raised surfaces (sidebar/tabs); bg3 is hover/active surfaces; border is hairline dividers. They must form a clear, subtle elevation ramp.
- fg is primary text, fgDim is muted text — both must have strong contrast against bg/bg2 (WCAG AA for fg).
- accent is the brand/active color; accentSoft is the SAME hue as a translucent rgba() (e.g. "rgba(124, 92, 255, 0.16)") for selection highlights.
- term.background should equal or closely match colors.bg; term.foreground match fg; cursor is usually the accent.
- All color fields except accentSoft are hex strings (#rrggbb). accentSoft is an rgba() string.
- radius.sm/md/lg are CSS px strings (e.g. "6px"/"8px"/"12px"), small→large. Rounder for soft/playful briefs, tighter for sharp/technical ones.
- appearance is "dark" or "light" depending on whether bg is dark or light.
Pick a tasteful, accessible palette that matches the brief's mood.`;

const JSON_HINT = `Return ONLY a JSON object (no markdown) with exactly these keys: {"name": string, "appearance": "dark"|"light", "colors": {"bg","bg2","bg3","border","fg","fgDim","accent","accentSoft"}, "radius": {"sm","md","lg"}, "term": {"background","foreground","cursor","selectionBackground"}}.`;

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "theme"
  );
}

export async function generateTheme(prompt: string): Promise<unknown> {
  const cfg = loadConfig();
  const slash = cfg.defaultModel.indexOf("/");
  const providerId = cfg.defaultModel.slice(0, slash);
  const model = cfg.defaultModel.slice(slash + 1);
  const provider = cfg.providers.find((p) => p.id === providerId);
  if (!provider) throw new Error("default model provider not found — open Model settings");

  const raw =
    provider.kind === "anthropic"
      ? await viaAnthropic(provider, model, prompt)
      : await viaOpenAI(provider, model, prompt);

  // Some providers ignore response_format and fence the JSON in ```json … ```
  // (or add prose around it) — extract the outermost object before parsing.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let theme: { name: string; id?: string };
  try {
    theme = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
  } catch {
    throw new Error("model returned invalid theme JSON — try again or switch the default model");
  }
  theme.id = `ai-${slug(theme.name)}-${Math.random().toString(36).slice(2, 6)}`;
  return theme;
}

async function viaAnthropic(provider: Provider, model: string, prompt: string): Promise<string> {
  if (!provider.apiKey) throw new Error(`${provider.name}: API key is not set`);
  const client = new Anthropic({
    apiKey: provider.apiKey,
    ...(provider.apiBase ? { baseURL: provider.apiBase } : {}),
  });
  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: THEME_SCHEMA } },
    messages: [{ role: "user", content: `Design a terminal theme: ${prompt}` }],
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("model returned no theme");
  return text.text;
}

async function viaOpenAI(provider: Provider, model: string, prompt: string): Promise<string> {
  if (!provider.apiKey) throw new Error(`${provider.name}: API key is not set`);
  const res = await fetch(`${provider.apiBase}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${SYSTEM}\n\n${JSON_HINT}` },
        { role: "user", content: `Design a terminal theme: ${prompt}` },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`${provider.name} API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${provider.name} returned no content`);
  return content;
}
