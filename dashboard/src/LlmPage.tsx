import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";

type Provider = "openai" | "anthropic";

interface Preset {
  label: string;
  provider: Provider;
  baseUrl: string;
  model: string;
  note: string;
}

// Starting points only. Any provider or model name can be typed in directly.
const PRESETS: Preset[] = [
  { label: "Groq (free tier)", provider: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-20b", note: "Free key at console.groq.com. Use Load models to see every model your key can use." },
  { label: "Google Gemini (free tier)", provider: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", note: "Free key at aistudio.google.com. Tool calling supported." },
  { label: "OpenRouter (free models)", provider: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", note: "Free key at openrouter.ai. Models ending in :free cost nothing." },
  { label: "Ollama (local, no key)", provider: "openai", baseUrl: "http://172.19.0.1:11434/v1", model: "qwen2.5:7b", note: "Runs on this machine. Pull a model with tool support first: ollama pull qwen2.5:7b. The URL is the Docker host bridge IP as seen from the cluster." },
  { label: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", note: "Paid API key from platform.openai.com." },
  { label: "Anthropic (Claude)", provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5", note: "Paid API key from console.anthropic.com." },
  { label: "Custom OpenAI-compatible", provider: "openai", baseUrl: "", model: "", note: "Any server that implements /chat/completions with tools." },
];

interface LlmView {
  configured: boolean;
  provider: Provider;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export function LlmPage() {
  const [current, setCurrent] = useState<LlmView | null>(null);
  const [form, setForm] = useState({ provider: "openai" as Provider, baseUrl: "", model: "", apiKey: "" });
  const [presetIndex, setPresetIndex] = useState(-1);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    api<LlmView>("GET", "/api/llm")
      .then((v) => {
        setCurrent(v);
        setForm((f) => ({ ...f, provider: v.provider, baseUrl: v.baseUrl, model: v.model }));
      })
      .catch((e) => setStatus({ kind: "error", text: e.message }));
  }, []);

  function applyPreset(i: number) {
    setPresetIndex(i);
    const p = PRESETS[i];
    if (!p) return;
    setForm((f) => ({ ...f, provider: p.provider, baseUrl: p.baseUrl, model: p.model }));
  }

  // Saves the form as shown. The form is the source of truth, so Save and Test
  // always act on what is on screen, never on an older saved value.
  async function saveSettings() {
    // An empty key field keeps the stored key. The key itself is never sent back.
    const body: Record<string, unknown> = { provider: form.provider, baseUrl: form.baseUrl, model: form.model };
    if (form.apiKey) body.apiKey = form.apiKey;
    await api("PUT", "/api/llm", body);
    const v = await api<LlmView>("GET", "/api/llm");
    setCurrent(v);
    setForm((f) => ({ ...f, apiKey: "" }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      await saveSettings();
      setStatus({ kind: "ok", text: "Saved." });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setStatus(null);
    try {
      await saveSettings();
      const r = await api<{ reply: string }>("POST", "/api/llm/test");
      setStatus({ kind: "ok", text: `Saved, and the model answered: ${r.reply}` });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setBusy(false);
    }
  }

  async function loadModels() {
    setBusy(true);
    setStatus(null);
    try {
      const r = await api<{ models: string[] }>("GET", "/api/llm/models");
      setModels(r.models);
      setStatus({ kind: "ok", text: `${r.models.length} models available for this key. Pick one below.` });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : "Could not list models" });
    } finally {
      setBusy(false);
    }
  }

  const preset = presetIndex >= 0 ? PRESETS[presetIndex] : undefined;

  return (
    <section>
      <h2>Model for the chat agent</h2>
      <p className="muted">
        Pick any provider and model. Free options: Groq, Google Gemini, OpenRouter (":free" models) and Ollama on this machine.
        The API key is encrypted on save and never shown again.
      </p>

      <div className="card">
        <strong>Current</strong>
        {current === null ? (
          <p className="muted small">Loading…</p>
        ) : current.configured ? (
          <p className="small">
            {current.model} via {current.baseUrl} ({current.provider}) · key {current.hasKey ? "stored" : "not needed"}
          </p>
        ) : (
          <p className="small error">No model configured. Chat is disabled until you save one.</p>
        )}
      </div>

      <form className="card" onSubmit={save}>
        <div className="grid">
          <label>
            Preset
            <select value={presetIndex} onChange={(e) => applyPreset(Number(e.target.value))}>
              <option value={-1}>Choose a starting point…</option>
              {PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Protocol
            <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as Provider })}>
              <option value="openai">OpenAI-compatible (most providers)</option>
              <option value="anthropic">Anthropic native</option>
            </select>
          </label>
          <label className="span2">
            Base URL
            <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" required />
          </label>
          <label>
            Model name
            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="any model your provider accepts" required />
            {models.length > 0 && (
              <select value={models.includes(form.model) ? form.model : ""} onChange={(e) => setForm({ ...form, model: e.target.value })}>
                <option value="">Pick from the provider's list…</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label>
            API key
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={current?.hasKey ? "stored; leave blank to keep" : "paste key (not needed for local Ollama)"}
              autoComplete="off"
            />
          </label>
        </div>
        {preset && <p className="small muted">{preset.note}</p>}
        <div className="row">
          <button type="submit" disabled={busy}>
            Save model
          </button>
          <button type="button" onClick={loadModels} disabled={busy || !current?.configured}>
            Load models from provider
          </button>
          <button type="button" onClick={test} disabled={busy || !form.model || !form.baseUrl}>
            Save and test model
          </button>
        </div>
        {status && <p className={status.kind === "ok" ? "small" : "error small"}>{status.text}</p>}
      </form>
    </section>
  );
}
