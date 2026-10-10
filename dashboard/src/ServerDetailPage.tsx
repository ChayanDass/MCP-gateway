import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type ServerView } from "./api";
import { Logo } from "./Logo";
import { navigate } from "./router";
import type { Provider } from "./ProvidersPanel";
import { AddServerModal } from "./AddServerModal";

type Tab = "overview" | "tools" | "settings";

// One server's own page, with tabs. The tab is part of the address: #/servers/<id>/<tab>.
export function ServerDetailPage({ id, tab, isAdmin }: { id: string; tab: Tab; isAdmin: boolean }) {
  const [server, setServer] = useState<ServerView | null | undefined>(undefined);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<ServerView[]>("GET", "/api/servers")
      .then((list) => setServer(list.find((s) => s.id === id) ?? null))
      .catch((e) => setError(e.message));
  }, [id]);

  const loadProviders = useCallback(() => {
    if (isAdmin) api<Provider[]>("GET", "/api/oauth-providers").then(setProviders).catch(() => undefined);
  }, [isAdmin]);

  useEffect(() => {
    load();
    loadProviders();
  }, [load, loadProviders]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  if (server === undefined) return <p className="muted">Loading…</p>;
  if (server === null) {
    return (
      <div className="page">
        <p className="status-line err">This server no longer exists.</p>
        <button onClick={() => navigate("servers")}>Back to MCP servers</button>
      </div>
    );
  }

  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: "overview", label: "Overview", show: true },
    { key: "tools", label: `Tools (${server.tools.length})`, show: true },
    { key: "settings", label: "Settings", show: isAdmin },
  ];
  const providerName = providers.find((p) => p.id === server.providerId)?.name ?? "Browser sign-in";

  return (
    <div className="page">
      <button className="back" onClick={() => navigate("servers")}>
        ← All MCP servers
      </button>

      <div className="detail-head">
        <Logo id={server.slug} size={52} />
        <div className="detail-title">
          <h2>{server.name}</h2>
          <span className="muted small">
            <code>{server.slug}</code> · {server.authMode === "oauth" ? `Browser sign-in · ${providerName}` : "Shared"}
            {server.isSystem ? " · system" : ""}
          </span>
        </div>
        <StatusChip server={server} />
      </div>

      <nav className="tabs" role="tablist">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? "tab on" : "tab"} onClick={() => navigate(`servers/${server.id}/${t.key}`)}>
              {t.label}
            </button>
          ))}
      </nav>

      {error && <p className="status-line err">{error}</p>}

      {tab === "overview" && (
        <Section title="Overview">
          <Field label="Address">
            <code>{server.url}</code>
          </Field>
          <Field label="Your connection">{yourConnection(server)}</Field>
          <Field label="Sign-in">{server.authMode === "oauth" ? providerName : server.hasCredential ? `Shared credential in ${server.authHeader ?? "Authorization"}` : "No sign-in"}</Field>
          <Field label="Tools">{server.tools.length} listed</Field>

          <div className="actions">
            {server.authMode === "oauth" && server.enabled && (server.status === "not_connected" || server.status === "reconnect") && (
              <a className="button-link primary" href={`/api/oauth/server/${server.id}/start`}>
                Connect your {server.name} account
              </a>
            )}
            {server.authMode === "oauth" && server.status === "connected" && (
              <button className="danger" disabled={busy} onClick={() => act(() => api("DELETE", `/api/oauth/server/${server.id}`))}>
                Disconnect your account
              </button>
            )}
          </div>

          {isAdmin && (
            <div className="actions">
              <label className="row check">
                <input type="checkbox" checked={server.chatEnabled} disabled={busy} onChange={() => act(() => api("PATCH", `/api/servers/${server.id}`, { chatEnabled: !server.chatEnabled }))} />
                Use in chat agent
              </label>
              <button disabled={busy} onClick={() => act(() => api("PATCH", `/api/servers/${server.id}`, { enabled: !server.enabled }))}>
                {server.enabled ? "Turn off" : "Turn on"}
              </button>
              <button className="danger" disabled={busy} onClick={() => window.confirm(`Remove ${server.name}?`) && act(async () => { await api("DELETE", `/api/servers/${server.id}`); navigate("servers"); })}>
                Remove server
              </button>
            </div>
          )}
          {server.status === "unreachable" && server.error && <p className="status-line err">{server.error}</p>}
        </Section>
      )}

      {tab === "tools" && (
        <Section title="Tools">
          {server.tools.length === 0 ? (
            <p className="muted small">{server.authMode === "oauth" ? "Tools appear here after you connect your account." : "This server lists no tools."}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Type</th>
                  <th>Rule</th>
                </tr>
              </thead>
              <tbody>
                {server.tools.map((t) => (
                  <tr key={t.name}>
                    <td>
                      <code>{t.name}</code>
                      <div className="muted small">{t.description.replace(/^\[[^\]]*\]\s*/, "").slice(0, 120)}</div>
                    </td>
                    <td>
                      <span className={`badge ${t.class}`}>{t.class}</span>
                    </td>
                    <td>
                      {isAdmin ? (
                        <select
                          value={t.override}
                          disabled={busy}
                          onChange={(e) => act(() => api("PUT", `/api/servers/${server.id}/tools`, { tool: t.name.slice(server.slug.length + 2), access: e.target.value }))}
                        >
                          <option value="auto">Automatic</option>
                          <option value="read">Read</option>
                          <option value="write">Write</option>
                          <option value="blocked">Blocked</option>
                        </select>
                      ) : (
                        <span className="muted small">{t.override === "auto" ? "Automatic" : t.override}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {tab === "settings" && isAdmin && (
        <Section title="Settings">
          <p className="muted small">Change the name, address or credential. The sign-in type can't change after creation.</p>
          <div className="actions">
            <button className="primary" onClick={() => setEditing(true)}>
              Edit server
            </button>
          </div>
        </Section>
      )}

      {editing && (
        <AddServerModal
          server={server}
          providers={providers}
          onClose={() => setEditing(false)}
          onProvidersChanged={loadProviders}
          onSaved={() => {
            setEditing(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function yourConnection(s: ServerView): string {
  switch (s.status) {
    case "connected":
      return `Connected (${s.toolCount ?? s.tools.length} tools)`;
    case "not_connected":
      return "Not connected";
    case "reconnect":
      return "Sign-in expired";
    case "unreachable":
      return "Unreachable";
    case "disabled":
      return "Turned off";
    default:
      return "Checking";
  }
}

function StatusChip({ server }: { server: ServerView }) {
  const tone = server.status === "connected" ? "ok" : server.status === "not_connected" || server.status === "reconnect" ? "warn" : server.status === "unreachable" ? "err" : "";
  return (
    <span className={`status-chip ${tone}`}>
      <span className={`dot ${tone}`} />
      {yourConnection(server)}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card section-card">
      <h3>{title}</h3>
      <div className="section-body">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="field-value">{children}</span>
    </div>
  );
}
