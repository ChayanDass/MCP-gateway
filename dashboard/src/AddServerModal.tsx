import { useEffect, useState, type FormEvent } from "react";
import { api, type ServerView } from "./api";
import type { Provider } from "./ProvidersPanel";
import { Modal } from "./Modal";
import { ProviderFormModal } from "./ProvidersPanel";
import { Logo } from "./Logo";

type Auth = "none" | "oauth";

// Add or edit an MCP server. Shared servers take an optional header credential;
// browser sign-in servers take a provider, and each member connects their own account.
export function AddServerModal({
  server,
  providers,
  onSaved,
  onClose,
  onProvidersChanged,
}: {
  server: ServerView | null;
  providers: Provider[];
  onSaved: () => void;
  onClose: () => void;
  onProvidersChanged?: () => void;
}) {
  const [addingProvider, setAddingProvider] = useState(false);
  const editing = server !== null;
  const [auth, setAuth] = useState<Auth>(server?.authMode === "oauth" ? "oauth" : "none");
  const [form, setForm] = useState({
    slug: server?.slug ?? "",
    name: server?.name ?? "",
    url: server?.url ?? "",
    authHeader: server?.authHeader ?? "",
    credential: "",
    providerId: server?.providerId ?? "",
    enabled: server?.enabled ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  // When a provider was just created, select it as soon as the list has it.
  useEffect(() => {
    if (!pendingSlug) return;
    const found = providers.find((p) => p.slug === pendingSlug);
    if (found) {
      setForm((f) => ({ ...f, providerId: found.id }));
      setPendingSlug(null);
    }
  }, [providers, pendingSlug]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (editing && server) {
        const body: Record<string, unknown> = { name: form.name, url: form.url, enabled: form.enabled };
        if (auth === "none") {
          body.authHeader = form.authHeader;
          if (form.credential) body.credential = form.credential;
        }
        await api("PATCH", `/api/servers/${server.id}`, body);
      } else {
        const body: Record<string, unknown> = { slug: form.slug, name: form.name, url: form.url, enabled: form.enabled };
        if (auth === "oauth") {
          body.authMode = "oauth";
          body.providerId = form.providerId;
        } else {
          body.authHeader = form.authHeader;
          body.credential = form.credential;
        }
        await api("POST", "/api/servers", body);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <Modal
      title={editing ? `Edit ${server?.name}` : "Add an MCP server"}
      subtitle={editing ? "Change the name, address or access settings." : "Choose how members sign in, then give the server's address."}
      onClose={onClose}
      wide
    >
      <form onSubmit={save}>
        {!editing && (
          <>
            <h4>How members sign in</h4>
            <div className="choice-row">
              <button type="button" className={`choice ${auth === "none" ? "on" : ""}`} onClick={() => setAuth("none")}>
                <strong>Shared</strong>
                <span className="muted small">No sign-in, or one header credential that everyone shares.</span>
              </button>
              <button type="button" className={`choice ${auth === "oauth" ? "on" : ""}`} onClick={() => setAuth("oauth")}>
                <strong>Browser sign-in</strong>
                <span className="muted small">Each member connects their own account through a provider.</span>
              </button>
            </div>
          </>
        )}

        <div className="grid">
          {!editing && (
            <label>
              Slug
              <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} pattern="[a-z0-9-]{2,40}" required placeholder="notion" />
            </label>
          )}
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label className="span2">
            URL (Streamable HTTP)
            <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://mcp.example.com/mcp" required />
          </label>
        </div>

        {auth === "none" && (
          <div className="grid">
            <label>
              Header name (optional)
              <input value={form.authHeader} onChange={(e) => setForm({ ...form, authHeader: e.target.value })} placeholder="Authorization" />
            </label>
            <label>
              Credential (optional)
              <input type="password" value={form.credential} onChange={(e) => setForm({ ...form, credential: e.target.value })} placeholder={editing ? "leave blank to keep" : "Bearer token or header value"} autoComplete="off" />
            </label>
          </div>
        )}

        {auth === "oauth" && !editing && (
          <>
            <h4>Provider</h4>
            <div className="choice-row">
              {providers.map((p) => (
                <button key={p.id} type="button" className={`choice ${form.providerId === p.id ? "on" : ""}`} onClick={() => setForm({ ...form, providerId: p.id })}>
                  <Logo id={p.slug} size={30} />
                  <strong>{p.name}</strong>
                  <span className="muted small">{p.hasSecret && p.clientId ? "Ready" : "Missing credentials"}</span>
                </button>
              ))}
              <button type="button" className="choice add-choice" onClick={() => setAddingProvider(true)}>
                <span className="add-plus">+</span>
                <strong>Add provider</strong>
                <span className="muted small">Set up a new sign-in service</span>
              </button>
            </div>
            {providers.length === 0 && <p className="muted small">No providers yet. Add one to continue.</p>}
          </>
        )}

        {error && <p className="status-line err">{error}</p>}
        <div className="row">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || (auth === "oauth" && !editing && !form.providerId)}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add server"}
          </button>
        </div>
      </form>
    </Modal>
    {addingProvider && (
      <ProviderFormModal
        provider={null}
        onClose={() => setAddingProvider(false)}
        onSaved={(slug) => {
          // Select the new provider once the list refreshes.
          setAddingProvider(false);
          onProvidersChanged?.();
          setPendingSlug(slug);
        }}
      />
    )}
    </>
  );
}
