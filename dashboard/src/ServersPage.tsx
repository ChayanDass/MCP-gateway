import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type ServerView } from "./api";

const EMPTY = { slug: "", name: "", url: "", authHeader: "", credential: "", enabled: true };

export function ServersPage({ isAdmin }: { isAdmin: boolean }) {
  const [servers, setServers] = useState<ServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ServerView[]>("GET", "/api/servers")
      .then(setServers)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (editing) {
        // Empty credential means "keep the stored one" when editing.
        const body: Record<string, unknown> = { name: form.name, url: form.url, enabled: form.enabled, authHeader: form.authHeader };
        if (form.credential) body.credential = form.credential;
        await api("PATCH", `/api/servers/${editing}`, body);
      } else {
        await api("POST", "/api/servers", form);
      }
      setForm(EMPTY);
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function action(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    }
  }

  function startEdit(s: ServerView) {
    setEditing(s.id);
    setForm({ slug: s.slug, name: s.name, url: s.url, authHeader: s.authHeader ?? "", credential: "", enabled: s.enabled });
  }

  return (
    <section>
      <h2>MCP servers</h2>
      <p className="muted">
        Every enabled server's tools are exposed through the gateway endpoint. Upstream credentials are never shown here.
      </p>
      {error && <p className="error">{error}</p>}
      {!servers && <p className="muted">Loading…</p>}

      {servers?.map((s) => (
        <div className="card" key={s.id}>
          <div className="row between">
            <div>
              <strong>{s.name}</strong> <code>{s.slug}</code> {s.isSystem && <span className="badge">system</span>}
              <div className="muted small">{s.url}</div>
            </div>
            <div className="row">
              <StatusBadge status={s.status} />
              {isAdmin && (
                <label className="row small" title="The chat agent sends only the tools of servers that are on. Keep it small: models have per-minute token limits.">
                  <input
                    type="checkbox"
                    checked={s.chatEnabled}
                    onChange={() => action(() => api("PATCH", `/api/servers/${s.id}`, { chatEnabled: !s.chatEnabled }))}
                  />
                  Use in chat agent
                </label>
              )}
              {isAdmin && (
                <>
                  <button onClick={() => startEdit(s)}>Edit</button>
                  <button onClick={() => action(() => api("PATCH", `/api/servers/${s.id}`, { enabled: !s.enabled }))}>
                    {s.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="danger" onClick={() => action(() => api("DELETE", `/api/servers/${s.id}`))}>
                    Remove
                  </button>
                </>
              )}
            </div>
          </div>
          {s.error && s.status === "unreachable" && <p className="error small">{s.error}</p>}
          {s.hasCredential && <p className="muted small">Credential stored ({s.authHeader ?? "Authorization"}), not shown.</p>}
          {s.tools.length > 0 && (
            <details>
              <summary>{s.tools.length} tools</summary>
              <ul className="tools">
                {s.tools.map((t) => (
                  <li key={t.name}>
                    <code>{t.name}</code> <span className="muted small">{t.description.replace(/^\[[^\]]*\]\s*/, "")}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}

      {isAdmin && (
        <form className="card" onSubmit={save}>
          <h3>{editing ? "Edit server" : "Add MCP server"}</h3>
          <div className="grid">
            <label>
              Slug
              <input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                disabled={!!editing}
                placeholder="analytics"
                pattern="[a-z0-9-]{2,40}"
                required={!editing}
              />
            </label>
            <label>
              Name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="span2">
              URL (Streamable HTTP)
              <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://svc.ns.svc.cluster.local:8080/mcp" required />
            </label>
            <label>
              Auth header (optional)
              <input value={form.authHeader} onChange={(e) => setForm({ ...form, authHeader: e.target.value })} placeholder="Authorization" />
            </label>
            <label>
              Credential (optional)
              <input
                type="password"
                value={form.credential}
                onChange={(e) => setForm({ ...form, credential: e.target.value })}
                placeholder={editing ? "leave blank to keep" : "Bearer token or header value"}
              />
            </label>
          </div>
          <div className="row">
            <button type="submit">{editing ? "Save changes" : "Add server"}</button>
            {editing && (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setForm(EMPTY);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: ServerView["status"] }) {
  const label = { connected: "Connected", unreachable: "Unreachable", disabled: "Disabled", unknown: "Checking" }[status];
  return <span className={`badge status-${status}`}>{label}</span>;
}
