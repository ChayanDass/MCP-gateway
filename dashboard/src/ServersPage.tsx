import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, type ServerView } from "./api";
import { AddServerModal } from "./AddServerModal";
import { ServerCard } from "./ServerCard";
import type { Provider } from "./ProvidersPanel";
import { Loading, Notice, Pill } from "./shared";

// The MCP servers list: a summary, then one tile per server. Each tile opens that server's page.
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Pill tone="ok">{connected} connected for you</Pill>
          <Pill tone="warn">{needSignIn} need sign-in</Pill>
          <Pill tone="muted">{servers?.length ?? 0} total</Pill>
        </div>
        {isAdmin && <Button onClick={() => setAdding(true)}>Add MCP server</Button>}
      </div>

      {error && <Notice tone="err">{error}</Notice>}
      {!servers && !error && <Loading lines={4} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
