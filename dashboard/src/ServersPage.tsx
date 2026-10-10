import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type ServerView } from "./api";
import { Logo } from "./Logo";
import { CatalogPanel } from "./CatalogPanel";

const EMPTY = { slug: "", name: "", url: "", authHeader: "", credential: "", enabled: true };

export function ServersPage({ isAdmin }: { isAdmin: boolean }) {
  const [servers, setServers] = useState<ServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

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
      setShowForm(false);
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
    setShowForm(true);
    setForm({ slug: s.slug, name: s.name, url: s.url, authHeader: s.authHeader ?? "", credential: "", enabled: s.enabled });
  }

  const connectedServers = servers?.filter((server) => server.status === "connected") ?? [];
  const otherServers = servers?.filter((server) => server.status !== "connected") ?? [];

  return (
    <section>
      <div className="servers-heading">
        <div>
          <h2>Your MCP connections</h2>
          <p className="muted">Browse integrations or connect your own MCP server.</p>
        </div>
        {isAdmin && (
          <button className="primary add-mcp-button" onClick={() => setShowForm((open) => !open)}>
            <span aria-hidden="true">+</span> {showForm && !editing ? "Close form" : "Add MCP"}
          </button>
        )}
      </div>
      <CatalogPanel isAdmin={isAdmin} onChanged={load} />
      {error && <p className="error">{error}</p>}
      {!servers && <p className="muted">Loading…</p>}

      {showForm && isAdmin && (
        <form className="card server-form" onSubmit={save}>
          <div className="server-form-heading">
            <div>
              <h3>{editing ? "Edit MCP server" : "Connect a custom MCP"}</h3>
              <p className="muted small">Add any Streamable HTTP MCP endpoint to your gateway.</p>
            </div>
            <button type="button" onClick={() => {
              setEditing(null);
              setForm(EMPTY);
              setShowForm(false);
            }}>
              Close
            </button>
          </div>
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
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Analytics MCP" required />
            </label>
            <label className="span2">
              Server URL (Streamable HTTP)
              <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://your-server.example.com/mcp" required />
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
                placeholder={editing ? "Leave blank to keep current" : "Enter a header value"}
              />
            </label>
          </div>
          <div className="row">
            <button type="submit" className="primary">{editing ? "Save changes" : "Connect server"}</button>
            {editing && (
              <button type="button" onClick={() => {
                setEditing(null);
                setForm(EMPTY);
                setShowForm(false);
              }}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      <div className="section-head connected-head">
        <h3 className="section">Connected MCPs</h3>
        <span className="muted small">{servers ? `${connectedServers.length} connected` : "Loading MCPs…"}</span>
      </div>
      {!servers?.length && <div className="empty-state">No MCP servers yet. Add one from the catalog or connect a custom server.</div>}
      {servers?.length !== undefined && connectedServers.length === 0 && servers.length > 0 && (
        <div className="empty-state">No MCPs are connected right now. Check the connection status below or connect an available MCP.</div>
      )}
      {connectedServers.map((server) => (
        <ServerCard key={server.id} server={server} isAdmin={isAdmin} onAction={action} onEdit={startEdit} />
      ))}
      {otherServers.length > 0 && (
        <>
          <div className="section-head connected-head">
            <h3 className="section">Other configured MCPs</h3>
            <span className="muted small">{otherServers.length} need attention or a connection</span>
          </div>
          {otherServers.map((server) => (
            <ServerCard key={server.id} server={server} isAdmin={isAdmin} onAction={action} onEdit={startEdit} />
          ))}
        </>
      )}

    </section>
  );
}

function ServerCard({
  server,
  isAdmin,
  onAction,
  onEdit,
}: {
  server: ServerView;
  isAdmin: boolean;
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
  onEdit: (server: ServerView) => void;
}) {
  return (
    <div className="card">
      <div className="row between">
        <div className="row">
          <Logo id={server.slug} size={34} />
          <div>
            <strong>{server.name}</strong> <code>{server.slug}</code> {server.isSystem && <span className="badge">system</span>}
            <div className="muted small">{server.url}</div>
          </div>
        </div>
        <div className="row">
          <StatusBadge status={server.status} />
          {isAdmin && (
            <label className="row small" title="Include this server in the chat agent. Keep the enabled set focused to stay within model context limits.">
              <input
                type="checkbox"
                checked={server.chatEnabled}
                onChange={() => onAction(() => api("PATCH", `/api/servers/${server.id}`, { chatEnabled: !server.chatEnabled }))}
              />
              Use in chat agent
            </label>
          )}
          {isAdmin && (
            <>
              <button onClick={() => onEdit(server)}>Edit</button>
              <button onClick={() => onAction(() => api("PATCH", `/api/servers/${server.id}`, { enabled: !server.enabled }))}>
                {server.enabled ? "Disable" : "Enable"}
              </button>
              <button className="danger" onClick={() => onAction(() => api("DELETE", `/api/servers/${server.id}`))}>
                Remove
              </button>
            </>
          )}
        </div>
      </div>
      {server.error && server.status === "unreachable" && <p className="error small">{server.error}</p>}
      {server.hasCredential && <p className="muted small">Credential stored ({server.authHeader ?? "Authorization"}), not shown.</p>}
    </div>
  );
}

function StatusBadge({ status }: { status: ServerView["status"] }) {
  const label: Record<ServerView["status"], string> = {
    connected: "Connected",
    unreachable: "Unreachable",
    disabled: "Disabled",
    unknown: "Checking",
    not_connected: "Not connected",
    reconnect: "Reconnect needed",
  };
  return <span className={`badge status-${status}`}>{label[status]}</span>;
}
