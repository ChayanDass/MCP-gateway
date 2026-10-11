import { useCallback, useEffect, useState } from "react";
import { api, type ServerView } from "./api";
import { AddServerModal } from "./AddServerModal";
import { ServerCard } from "./ServerCard";
import type { Provider } from "./ProvidersPanel";
import { EmptyState, Skeleton } from "./ui";

// The MCP servers list page: a summary, then one tile per server. Each tile opens
// that server's own page.
export function ServersPage({ isAdmin }: { isAdmin: boolean }) {
  const [servers, setServers] = useState<ServerView[] | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api<ServerView[]>("GET", "/api/servers").then(setServers).catch((e) => setError(e.message));
  }, []);

  const loadProviders = useCallback(() => {
    if (isAdmin) api<Provider[]>("GET", "/api/oauth-providers").then(setProviders).catch(() => undefined);
  }, [isAdmin]);

  useEffect(() => {
    load();
    loadProviders();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load, loadProviders]);

  const connected = servers?.filter((s) => s.status === "connected").length ?? 0;
  const needSignIn = servers?.filter((s) => s.authMode === "oauth" && (s.status === "not_connected" || s.status === "reconnect")).length ?? 0;
  const providerName = (id?: string | null) => providers.find((p) => p.id === id)?.name ?? "Browser sign-in";

  return (
    <div className="page">
      <div className="page-bar">
        <div className="summary">
          <span className="pill ok">{connected} connected for you</span>
          <span className="pill warn">{needSignIn} need sign-in</span>
          <span className="pill">{servers?.length ?? 0} total</span>
        </div>
        {isAdmin && (
          <button className="primary" onClick={() => setAdding(true)}>
            Add MCP server
          </button>
        )}
      </div>

      {error && <p className="status-line err">{error}</p>}
      {!servers && !error && <Skeleton lines={4} />}

      <div className="tile-grid">
        {servers?.map((s) => <ServerCard key={s.id} server={s} providerName={providerName(s.providerId)} onChanged={load} />)}
      </div>

      {adding && (
        <AddServerModal
          server={null}
          providers={providers}
          onClose={() => setAdding(false)}
          onProvidersChanged={loadProviders}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </div>
  );
}
