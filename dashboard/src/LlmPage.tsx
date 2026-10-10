import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { Logo } from "./Logo";

type Provider = "openai" | "anthropic";

interface Preset {
  id: string;
  label: string;
  provider: Provider;
  baseUrl: string;
  model: string;
  note: string;
}

// Starting points only. Any provider or model name can still be typed in.
const PRESETS: Preset[] = [
  { id: "groq", label: "Groq", provider: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-20b", note: "Free key at console.groq.com. Fast, with tool calling." },
  { id: "gemini", label: "Google Gemini", provider: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", note: "Free key at aistudio.google.com." },
  { id: "openrouter", label: "OpenRouter", provider: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", note: "Models ending in :free cost nothing." },
  { id: "ollama", label: "Ollama", provider: "openai", baseUrl: "http://172.19.0.1:11434/v1", model: "qwen2.5:7b", note: "Runs on this machine, no key. Pull a model with tool support first." },
  { id: "openai", label: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", note: "Paid key from platform.openai.com." },
  { id: "anthropic", label: "Anthropic", provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5", note: "Paid key from console.anthropic.com." },
  { id: "custom", label: "Custom", provider: "openai", baseUrl: "", model: "", note: "Any server that implements /chat/completions with tools." },
];

interface LlmView {
  configured: boolean;
  provider: Provider;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  catalog: string[];
  catalogAt: string | null;
}

export function LlmPage() {
  const [current, setCurrent] = useState<LlmView | null>(null);
  const [form, setForm] = useState({ provider: "openai" as Provider, baseUrl: "", model: "", apiKey: "" });
  const [presetId, setPresetId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function apply(v: LlmView) {
    setCurrent(v);
    setCatalog(v.catalog ?? []);
    setForm((f) => ({ ...f, provider: v.provider, baseUrl: v.baseUrl, model: v.model }));
    const match = PRESETS.find((p) => p.baseUrl && p.baseUrl === v.baseUrl);
    setPresetId(match?.id ?? null);
  }

  useEffect(() => {
    api<LlmView>("GET", "/api/llm")
      .then(apply)
      .catch((e) => setStatus({ kind: "error", text: e.message }));
  }, []);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setStatus(null);
    try {
      await fn();
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  // Saves the form as shown. The form is the source of truth.
  async function saveSettings() {
    const body: Record<string, unknown> = { provider: form.provider, baseUrl: form.baseUrl, model: form.model };
    if (form.apiKey) body.apiKey = form.apiKey;
    await api("PUT", "/api/llm", body);
    setForm((f) => ({ ...f, apiKey: "" }));
    apply(await api<LlmView>("GET", "/api/llm"));
  }

  function choosePreset(p: Preset) {
    setPresetId(p.id);
    setForm((f) => ({ ...f, provider: p.provider, baseUrl: p.baseUrl, model: p.model }));
  }

  async function useModel(model: string) {
    setForm((f) => ({ ...f, model }));
    await run("use", async () => {
      await api("PUT", "/api/llm", { provider: form.provider, baseUrl: form.baseUrl, model });
      apply(await api<LlmView>("GET", "/api/llm"));
      setStatus({ kind: "ok", text: `${model} is now the model for the chat agent.` });
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    await run("save", async () => {
      await saveSettings();
      setStatus({ kind: "ok", text: "Saved." });
    });
  }

  async function loadModels() {
    await run("models", async () => {
      await saveSettings();
      const r = await api<{ models: string[] }>("GET", "/api/llm/models");
      setCatalog(r.models);
      setStatus({ kind: "ok", text: `${r.models.length} models stored from this provider.` });
    });
  }

  async function test() {
    await run("test", async () => {
      await saveSettings();
      const r = await api<{ reply: string }>("POST", "/api/llm/test");
      setStatus({ kind: "ok", text: `Model answered: ${r.reply}` });
    });
  }

  const shown = catalog.filter((m) => m.toLowerCase().includes(filter.toLowerCase()));
  const preset = PRESETS.find((p) => p.id === presetId);
  const inUse = current?.configured ? current.model : null;

  return (
    <div className="model-page">
      <div className="card in-use">
        <div className="card-head">
          <h3>Model in use</h3>
          {current?.configured ? <span className="badge read">Active</span> : <span className="badge write">Not set</span>}
        </div>
        {current?.configured ? (
          <div className="model-row">
            <Logo id={presetFor(current.baseUrl, current.provider)} size={44} />
            <div>
              <div className="strong big">{current.model}</div>
              <div className="muted small">
                {current.baseUrl} · {current.provider === "anthropic" ? "Anthropic protocol" : "OpenAI-compatible"} · key {current.hasKey ? "stored" : "not needed"}
              </div>
            </div>
          </div>
        ) : (
          <p className="error">No model is set. Chat is disabled until you pick one.</p>
        )}
      </div>

      <h3 className="section">Provider</h3>
      <div className="provider-grid">
        {PRESETS.map((p) => (
          <button key={p.id} className={`provider ${presetId === p.id ? "selected" : ""}`} onClick={() => choosePreset(p)}>
            <Logo id={p.id} size={34} />
            <span className="provider-name">{p.label}</span>
            <span className="muted small">{p.provider === "anthropic" ? "Native" : "OpenAI-compatible"}</span>
          </button>
        ))}
      </div>
      {preset && <p className="small muted hint">{preset.note}</p>}

      <form className="card" onSubmit={save}>
        <div className="grid">
          <label className="span2">
            Base URL
            <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" required />
          </label>
          <label>
            Protocol
            <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as Provider })}>
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic native</option>
            </select>
          </label>
          <label>
            API key
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={current?.hasKey ? "stored. Leave blank to keep it" : "paste key (not needed for local Ollama)"}
              autoComplete="off"
            />
          </label>
          <label className="span2">
            Model name
            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="any model your provider accepts" required />
          </label>
        </div>
        <div className="row">
          <button type="submit" className="primary" disabled={!!busy}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={test} disabled={!!busy || !form.model || !form.baseUrl}>
            {busy === "test" ? "Testing…" : "Save and test"}
          </button>
          <button type="button" onClick={loadModels} disabled={!!busy || !form.baseUrl}>
            {busy === "models" ? "Loading…" : "Load models from provider"}
          </button>
        </div>
        {status && <p className={status.kind === "ok" ? "small status-line ok" : "small status-line err"}>{status.text}</p>}
      </form>

      <div className="card-head catalog-head">
        <h3 className="section">Stored models {catalog.length > 0 && <span className="muted small">({catalog.length})</span>}</h3>
        {catalog.length > 0 && <input className="search" placeholder="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      </div>
      {catalog.length === 0 ? (
        <p className="muted small">Click "Load models from provider" to fetch and store the list. Then pick one to use.</p>
      ) : (
        <div className="model-grid">
          {shown.map((m) => (
            <div key={m} className={`model-card ${inUse === m ? "in-use-card" : ""}`}>
              <div className="model-name" title={m}>
                {m}
              </div>
              <div className="row between">
                {inUse === m ? (
                  <span className="badge read">In use</span>
                ) : (
                  <button className="small-btn" onClick={() => useModel(m)} disabled={!!busy}>
                    Use this model
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function presetFor(baseUrl: string, provider: Provider): string {
  if (provider === "anthropic") return "anthropic";
  const p = PRESETS.find((x) => x.baseUrl && baseUrl.startsWith(x.baseUrl.split("/v1")[0]));
  return p?.id ?? "custom";
}
