import { useEffect, useState } from "react";
import { CloseIcon, EditIcon, PlusIcon } from "./icons";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:5174";

/** A provider as held in local edit state (apiKey starts as the masked value). */
interface Provider {
  id: string;
  name: string;
  apiBase: string;
  apiKey: string;
  models: string[];
  builtin: boolean;
  managed: boolean;
  hasKey: boolean;
}

interface Draft {
  id: string;
  name: string;
  apiBase: string;
  apiKey: string;
  modelsText: string;
}

const newId = () => crypto.randomUUID();

/** Model-provider settings — built-in managed Anthropic + custom OpenAI-compatible. */
export function ModelSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/models`)
      .then((r) => r.json())
      .then((cfg) => {
        setProviders(
          cfg.providers.map((p: any) => ({
            id: p.id,
            name: p.name,
            apiBase: p.apiBase,
            apiKey: p.keyMask ?? "", // masked; server treats unchanged-masked as "keep"
            models: p.models,
            builtin: p.builtin,
            managed: p.managed,
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
    setDraft({ id: p.id, name: p.name, apiBase: p.apiBase, apiKey: "", modelsText: p.models.join("\n") });
  }
  function openAdd() {
    setDraft({ id: newId(), name: "", apiBase: "", apiKey: "", modelsText: "" });
  }

  function commitDraft() {
    if (!draft) return;
    const models = draft.modelsText
      .split(/[\n,]/)
      .map((m) => m.trim())
      .filter(Boolean);
    const next: Provider = {
      id: draft.id,
      name: draft.name.trim() || "Provider",
      apiBase: draft.apiBase.trim(),
      apiKey: draft.apiKey, // typed key, or "" to keep existing on save
      models,
      builtin: false,
      managed: false,
      hasKey: true,
    };
    setProviders((ps) => {
      const i = ps.findIndex((p) => p.id === next.id);
      // Editing keeps the masked apiKey if the user left it blank.
      if (i >= 0) {
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
        providers: providers
          .filter((p) => !p.builtin)
          .map((p) => ({
            id: p.id,
            name: p.name,
            apiBase: p.apiBase,
            apiKey: p.apiKey, // masked/"" → server keeps stored key
            models: p.models,
          })),
      };
      const res = await fetch(`${API_URL}/api/models`, {
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
          onChange={(e) => setDefaultModel(e.target.value)}
        >
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="ms-hint">Used by Termany's AI features (theme generation, …).</div>
      </div>

      <table className="ms-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>API Base</th>
            <th>API Key</th>
            <th>Models</th>
            <th>Source</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>
                <code className="ms-mono">{p.managed ? "Managed gateway" : p.apiBase || "—"}</code>
              </td>
              <td>
                <code className="ms-mono">
                  {p.managed ? (p.hasKey ? "Managed" : "No env key") : p.apiKey || "—"}
                </code>
              </td>
              <td>{p.models.length}</td>
              <td>
                <span className={`ms-badge ${p.builtin ? "builtin" : ""}`}>
                  {p.builtin ? "Built-in" : "Custom"}
                </span>
              </td>
              <td className="ms-actions">
                {!p.builtin && (
                  <>
                    <button className="ms-icon" title="Edit" onClick={() => openEdit(p)}>
                      <EditIcon />
                    </button>
                    <button className="ms-icon" title="Delete" onClick={() => remove(p.id)}>
                      <CloseIcon />
                    </button>
                  </>
                )}
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
              <span>Name</span>
              <input
                value={draft.name}
                placeholder="DeepSeek"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="ms-field">
              <span>API Base</span>
              <input
                value={draft.apiBase}
                placeholder="https://api.deepseek.com"
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
                placeholder="deepseek-chat"
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
