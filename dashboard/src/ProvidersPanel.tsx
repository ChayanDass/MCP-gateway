import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { copyText } from "./connect";
import { Modal } from "./Modal";

export interface Provider {
  id: string;
  slug: string;
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  scopeParam: "scope" | "user_scope";
  pkce: boolean;
  tokenPath: string;
  clientId: string;
  hasSecret: boolean;
  redirectUri: string;
}

const EMPTY = {
  name: "",
  slug: "",
  authorizeUrl: "",
  tokenUrl: "",
  scopes: "",
  scopeParam: "scope" as "scope" | "user_scope",
  pkce: true,
  tokenPath: "access_token",
  clientId: "",
  clientSecret: "",
};

// The provider form in a window. Used on the providers page and from the add-server
// window, so an admin can create a provider without leaving the server they're adding.
export function ProviderFormModal({ provider, onSaved, onClose }: { provider: Provider | null; onSaved: (slug: string) => void; onClose: () => void }) {
  const editing = provider?.slug ?? null;
  const [form, setForm] = useState(() =>
    provider
      ? { ...EMPTY, name: provider.name, slug: provider.slug, authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl, scopes: provider.scopes, scopeParam: provider.scopeParam, pkce: provider.pkce, tokenPath: provider.tokenPath, clientId: provider.clientId, clientSecret: "" }
      : EMPTY,
  );
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof EMPTY, v: string | boolean) => setForm({ ...form, [k]: v });

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (editing) {
        const body: Record<string, unknown> = { ...form };
        if (!form.clientSecret) delete body.clientSecret;
        await api("PUT", `/api/oauth-providers/${editing}`, body);
      } else {
        await api("POST", "/api/oauth-providers", form);
      }
      onSaved(form.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the provider");
    }
  }

  return (
    <Modal title={editing ? `Edit ${provider?.name}` : "Add a sign-in provider"} subtitle="Create the app in the provider, then paste its client ID and secret here. You can copy the redirect address after saving." onClose={onClose} wide>
      <form onSubmit={save}>
        <div className="grid">
          <label>
            Name
            <input value={form.name} onChange={(e) => set("name", e.target.value)} required placeholder="e.g. Notion" />
          </label>
          <label>
            Slug
            <input value={form.slug} onChange={(e) => set("slug", e.target.value.toLowerCase())} required disabled={!!editing} pattern="[a-z0-9-]{2,40}" placeholder="notion" />
          </label>
          <label className="span2">
            Authorize URL
            <input value={form.authorizeUrl} onChange={(e) => set("authorizeUrl", e.target.value)} required placeholder="https://provider.example/oauth/authorize" />
          </label>
          <label className="span2">
            Token URL
            <input value={form.tokenUrl} onChange={(e) => set("tokenUrl", e.target.value)} required placeholder="https://provider.example/oauth/token" />
          </label>
          <label className="span2">
            Scopes (comma-separated)
            <input value={form.scopes} onChange={(e) => set("scopes", e.target.value)} placeholder="read write" />
          </label>
          <label>
            Client ID
            <input value={form.clientId} onChange={(e) => set("clientId", e.target.value)} required={!editing} />
          </label>
          <label>
            Client secret
            <input type="password" value={form.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} required={!editing} placeholder={editing ? "leave blank to keep" : ""} autoComplete="off" />
          </label>
          <label>
            Scope parameter
            <input value={form.scopeParam} onChange={(e) => set("scopeParam", e.target.value)} placeholder="scope or user_scope" />
          </label>
          <label>
            Token field in the response
            <input value={form.tokenPath} onChange={(e) => set("tokenPath", e.target.value)} placeholder="access_token" />
          </label>
        </div>
        <label className="row check">
          <input type="checkbox" checked={form.pkce} onChange={(e) => set("pkce", e.target.checked)} />
          Use PKCE (turn off if the provider rejects it)
        </label>
        {error && <p className="status-line err">{error}</p>}
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary">{editing ? "Save provider" : "Add provider"}</button>
        </div>
      </form>
    </Modal>
  );
}

// Sign-in providers: the services members sign in to. Each one stores its client ID
// and encrypted secret. Lives on its own page under Settings.
export function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () => api<Provider[]>("GET", "/api/oauth-providers").then(setProviders).catch((e) => setStatus({ kind: "err", text: e.message }));
  useEffect(() => {
    load();
  }, []);

  function edit(p: Provider) {
    setEditing(p.slug);
    setOpen(true);
    setForm({ ...EMPTY, name: p.name, slug: p.slug, authorizeUrl: p.authorizeUrl, tokenUrl: p.tokenUrl, scopes: p.scopes, scopeParam: p.scopeParam, pkce: p.pkce, tokenPath: p.tokenPath, clientId: p.clientId, clientSecret: "" });
  }

  function close() {
    setOpen(false);
    setEditing(null);
    setForm(EMPTY);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setStatus(null);
    try {
      if (editing) {
        const body: Record<string, unknown> = { ...form };
        if (!form.clientSecret) delete body.clientSecret;
        await api("PUT", `/api/oauth-providers/${editing}`, body);
      } else {
        await api("POST", "/api/oauth-providers", form);
      }
      close();
      load();
    } catch (err) {
      setStatus({ kind: "err", text: err instanceof Error ? err.message : "Could not save the provider" });
    }
  }

  async function remove(p: Provider) {
    if (!window.confirm(`Delete ${p.name}? Servers that use it stop working until you pick another provider.`)) return;
    try {
      await api("DELETE", `/api/oauth-providers/${p.slug}`);
      load();
    } catch (err) {
      setStatus({ kind: "err", text: err instanceof Error ? err.message : "Could not delete" });
    }
  }

  const set = (k: keyof typeof EMPTY, v: string | boolean) => setForm({ ...form, [k]: v });

  return (
    <div className="page">
      <div className="page-bar">
        <p className="muted small">Create the app in the provider, then paste its client ID and secret here. Paste the redirect address into the app's settings.</p>
        <button className="primary" onClick={() => { setEditing(null); setForm(EMPTY); setOpen(true); }}>
          Add provider
        </button>
      </div>

      {status && <p className={status.kind === "ok" ? "status-line ok" : "status-line err"}>{status.text}</p>}
      {providers && providers.length === 0 && <p className="muted">No providers yet.</p>}

      <div className="tile-grid">
        {providers?.map((p) => (
          <div key={p.id} className="provider-tile">
            <div className="row between">
              <strong>{p.name}</strong>
              <span className={`badge ${p.hasSecret && p.clientId ? "read" : "write"}`}>{p.hasSecret && p.clientId ? "Ready" : "Missing credentials"}</span>
            </div>
            <div className="muted small">
              <code>{p.slug}</code> · {p.pkce ? "PKCE" : "no PKCE"} · <code>{p.scopeParam}</code>
            </div>
            <div className="redirect-row">
              <code className="redirect">{p.redirectUri}</code>
              <button
                className="small-btn"
                onClick={async () => {
                  setCopied((await copyText(p.redirectUri)) ? p.slug : null);
                  setTimeout(() => setCopied(null), 1500);
                }}
              >
                {copied === p.slug ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="row">
              <button className="small-btn" onClick={() => edit(p)}>Edit</button>
              <button className="small-btn danger" onClick={() => remove(p)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {open && (
        <ProviderFormModal
          provider={providers?.find((p) => p.slug === editing) ?? null}
          onSaved={() => {
            close();
            load();
          }}
          onClose={close}
        />
      )}
    </div>
  );
}
