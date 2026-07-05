import { useEffect, useState } from "react";
import { apiPath } from "../api";
import { CloseIcon, EditIcon, PlusIcon } from "./icons";

type Kind = "anthropic" | "openai";

/** A provider as held in local edit state (apiKey starts as the masked value). */
interface Provider {
  id: string;
  name: string;
  apiBase: string;
  apiKey: string;
  models: string[];
  kind: Kind;
  hasKey: boolean;
}

interface Draft {
  id: string;
  name: string;
  apiBase: string;
  apiKey: string;
  modelsText: string;
  kind: Kind;
}

const newId = () => crypto.randomUUID();

/** Model-provider settings — BYOK: the user adds their own Anthropic or
 *  OpenAI-compatible providers with their own API key. No managed built-in. */
export function ModelSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(apiPath("/api/models"))
      .then((r) => r.json())
      .then((cfg) => {
        setProviders(
          cfg.providers.map((p: any) => ({
            id: p.id,
            name: p.name,
            apiBase: p.apiBase,
            apiKey: p.keyMask ?? "", // masked; server treats unchanged-masked as "keep"
            models: p.models,
            kind: p.kind === "anthropic" ? "anthropic" : "openai",
            hasKey: p.hasKey,
          }))
        );
        setDefaultModel(cfg.defaultModel);
      })
      .catch((e) => setStatus(`Load failed: ${e.message}`));
  }, []);

  const modelOptions = providers.flatMap((p) =>
    p.models.map((m) => ({ value: `${p.id}/${m}`, label: `${p.name} / ${m}` }))
  );

  function openEdit(p: Provider) {
    setDraft({
      id: p.id,
      name: p.name,
      apiBase: p.apiBase,
      apiKey: "",
      modelsText: p.models.join("\n"),
      kind: p.kind,
    });
  }
  function openAdd() {
    // Default to Anthropic — the AI features are Claude-first; prefill the model.
    setDraft({
      id: newId(),
      name: "",
      apiBase: "",
      apiKey: "",
      modelsText: "claude-opus-4-8",
      kind: "anthropic",
    });
  }

  function commitDraft() {
    if (!draft) return;
    const models = draft.modelsText
      .split(/[\n,]/)
      .map((m) => m.trim())
      .filter(Boolean);
    const next: Provider = {
      id: draft.id,
      name: draft.name.trim() || (draft.kind === "anthropic" ? "Anthropic" : "Provider"),
      apiBase: draft.apiBase.trim(),
      apiKey: draft.apiKey, // typed key, or "" to keep existing on save
      models,
      kind: draft.kind,
      hasKey: true,
    };
    setProviders((ps) => {
      const i = ps.findIndex((p) => p.id === next.id);
      if (i >= 0) {
        // Editing keeps the masked apiKey if the user left it blank.
        const keptKey = draft.apiKey ? draft.apiKey : ps[i].apiKey;
        const copy = [...ps];
        copy[i] = { ...next, apiKey: keptKey };
        return copy;
      }
      return [...ps, next];
    });
    setDraft(null);
  }

  function remove(id: string) {
    setProviders((ps) => ps.filter((p) => p.id !== id));
  }

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const payload = {
        defaultModel,
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          apiBase: p.apiBase,
          apiKey: p.apiKey, // masked/"" → server keeps stored key
          models: p.models,
          kind: p.kind,
        })),
      };
      const res = await fetch(apiPath("/api/models"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const cfg = await res.json();
      if (!res.ok) throw new Error(cfg.error ?? `request failed (${res.status})`);
      setDefaultModel(cfg.defaultModel);
      setStatus("Saved");
    } catch (e) {
      setStatus(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="ms-head">
        <div className="settings-section-title">MODEL SETTINGS</div>
        <div className="ms-head-actions">
          <button className="ms-btn" onClick={openAdd}>
            <PlusIcon /> Add provider
          </button>
          <button className="ms-btn primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="ms-card">
        <div className="ms-card-title">Default model</div>
        <select
          className="ms-select"
          value={defaultModel}
          disabled={modelOptions.length === 0}
          onChange={(e) => setDefaultModel(e.target.value)}
        >
          {modelOptions.length === 0 ? (
            <option value="">— add a provider below —</option>
          ) : (
            modelOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          )}
        </select>
        <div className="ms-hint">
          Bring your own key. Used by Termany's AI features (theme generation, …).
        </div>
      </div>

      <table className="ms-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>API Base</th>
            <th>API Key</th>
            <th>Models</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {providers.length === 0 && (
            <tr>
              <td colSpan={6} className="ms-empty">
                No providers yet — add one with your own API key.
              </td>
            </tr>
          )}
          {providers.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.kind === "anthropic" ? "Anthropic" : "OpenAI-compatible"}</td>
              <td>
                <code className="ms-mono">
                  {p.apiBase || (p.kind === "anthropic" ? "api.anthropic.com" : "—")}
                </code>
              </td>
              <td>
                <code className="ms-mono">{p.hasKey ? p.apiKey || "••••" : "No key"}</code>
              </td>
              <td>{p.models.length}</td>
              <td className="ms-actions">
                <button className="ms-icon" title="Edit" onClick={() => openEdit(p)}>
                  <EditIcon />
                </button>
                <button className="ms-icon" title="Delete" onClick={() => remove(p.id)}>
                  <CloseIcon />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {status && <div className="ms-status">{status}</div>}

      {draft && (
        <div className="ms-form-backdrop" onClick={() => setDraft(null)}>
          <div className="ms-form" onClick={(e) => e.stopPropagation()}>
            <div className="ms-form-title">Provider</div>
            <label className="ms-field">
              <span>Type</span>
              <select
                value={draft.kind}
                onChange={(e) => {
                  const kind = e.target.value as Kind;
                  setDraft((d) =>
                    d
                      ? {
                          ...d,
                          kind,
                          // Helpful default model when switching to Anthropic.
                          modelsText:
                            kind === "anthropic" && !d.modelsText.trim()
                              ? "claude-opus-4-8"
                              : d.modelsText,
                        }
                      : d
                  );
                }}
              >
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI-compatible</option>
              </select>
            </label>
            <label className="ms-field">
              <span>Name</span>
              <input
                value={draft.name}
                placeholder={draft.kind === "anthropic" ? "Anthropic" : "DeepSeek"}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="ms-field">
              <span>API Base</span>
              <input
                value={draft.apiBase}
                placeholder={
                  draft.kind === "anthropic"
                    ? "blank = api.anthropic.com (optional)"
                    : "https://api.deepseek.com"
                }
                onChange={(e) => setDraft({ ...draft, apiBase: e.target.value })}
              />
            </label>
            <label className="ms-field">
              <span>API Key</span>
              <input
                type="password"
                value={draft.apiKey}
                placeholder="Leave blank to keep current"
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
            </label>
            <label className="ms-field">
              <span>Models (one per line)</span>
              <textarea
                rows={3}
                value={draft.modelsText}
                placeholder={draft.kind === "anthropic" ? "claude-opus-4-8" : "deepseek-chat"}
                onChange={(e) => setDraft({ ...draft, modelsText: e.target.value })}
              />
            </label>
            <div className="ms-form-actions">
              <button className="ms-btn" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button className="ms-btn primary" onClick={commitDraft}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
