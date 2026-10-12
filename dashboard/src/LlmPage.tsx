import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api } from "./api";
import { Logo } from "./Logo";
import { Notice, Pill, Panel } from "./shared";

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
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Model in use</CardTitle>
          {current?.configured ? <Pill tone="ok">Active</Pill> : <Pill tone="warn">Not set</Pill>}
        </CardHeader>
        <CardContent>
          {current?.configured ? (
            <div className="flex items-center gap-3">
              <Logo id={presetFor(current.baseUrl, current.provider)} size={44} />
              <div className="min-w-0">
                <div className="truncate font-semibold">{current.model}</div>
                <div className="truncate text-sm text-muted-foreground">
                  {current.baseUrl} · {current.provider === "anthropic" ? "Anthropic protocol" : "OpenAI-compatible"} · key {current.hasKey ? "stored" : "not needed"}
                </div>
              </div>
            </div>
          ) : (
            <Notice tone="err">No model is set. Chat is disabled until you pick one.</Notice>
          )}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h3 className="font-medium">Provider</h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => choosePreset(p)}
              className={cn("flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/60", presetId === p.id && "border-primary bg-accent")}
            >
              <Logo id={p.id} size={30} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{p.label}</span>
                <span className="block text-xs text-muted-foreground">{p.provider === "anthropic" ? "Native" : "OpenAI-compatible"}</span>
              </span>
            </button>
          ))}
        </div>
        {preset && <p className="text-sm text-muted-foreground">{preset.note}</p>}
      </div>

      <Panel title="Connection">
        <form className="space-y-5" onSubmit={save}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="llm-url">Base URL</Label>
              <Input id="llm-url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" required />
            </div>
            <div className="space-y-2">
              <Label>Protocol</Label>
              <Select value={form.provider} onValueChange={(v) => setForm({ ...form, provider: v as Provider })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI-compatible</SelectItem>
                  <SelectItem value="anthropic">Anthropic native</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="llm-key">API key</Label>
              <Input
                id="llm-key"
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder={current?.hasKey ? "stored. Leave blank to keep it" : "paste key (not needed for local Ollama)"}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="llm-model">Model name</Label>
              <Input id="llm-model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="any model your provider accepts" required />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!!busy}>
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="outline" onClick={test} disabled={!!busy || !form.model || !form.baseUrl}>
              {busy === "test" ? "Testing…" : "Save and test"}
            </Button>
            <Button type="button" variant="outline" onClick={loadModels} disabled={!!busy || !form.baseUrl}>
              {busy === "models" ? "Loading…" : "Load models from provider"}
            </Button>
          </div>
          {status && <Notice tone={status.kind === "ok" ? "ok" : "err"}>{status.text}</Notice>}
        </form>
      </Panel>

      <Panel
        title={`Stored models${catalog.length > 0 ? ` (${catalog.length})` : ""}`}
        actions={catalog.length > 0 && <Input className="w-56" placeholder="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      >
        {catalog.length === 0 ? (
          <p className="text-sm text-muted-foreground">Click "Load models from provider" to fetch and store the list. Then pick one to use.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((m) => (
              <div key={m} className={cn("flex items-center justify-between gap-2 rounded-lg border p-3", inUse === m && "border-primary")}>
                <span className="min-w-0 truncate text-sm" title={m}>{m}</span>
                {inUse === m ? (
                  <Pill tone="ok">In use</Pill>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => useModel(m)} disabled={!!busy}>
                    Use
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function presetFor(baseUrl: string, provider: Provider): string {
  if (provider === "anthropic") return "anthropic";
  const p = PRESETS.find((x) => x.baseUrl && baseUrl.startsWith(x.baseUrl.split("/v1")[0]));
  return p?.id ?? "custom";
}
