import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, can, type Me, type ServerView } from "./api";
import { AddServerModal } from "./AddServerModal";
import { Logo } from "./Logo";
import { navigate } from "./router";
import type { Provider } from "./ProvidersPanel";
import { ClassBadge, ConfirmDialog, Field, Notice, Panel, Pill, type Tone } from "./shared";

type Tab = "overview" | "tools" | "settings";

// One server's own page, with tabs. The tab is part of the address: #/servers/<id>/<tab>.
export function ServerDetailPage({ id, tab, me }: { id: string; tab: Tab; me: Me }) {
  const canManage = can(me, "servers.manage");
  const canTools = can(me, "tools.manage");
  const [server, setServer] = useState<ServerView | null | undefined>(undefined);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const load = useCallback(() => {
    api<ServerView[]>("GET", "/api/servers")
      .then((list) => setServer(list.find((s) => s.id === id) ?? null))
      .catch((e) => setError(e.message));
  }, [id]);

  const loadProviders = useCallback(() => {
    if (canManage) api<Provider[]>("GET", "/api/oauth-providers").then(setProviders).catch(() => undefined);
  }, [canManage]);

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

  if (server === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (server === null) {
    return (
      <div className="space-y-4">
        <Notice tone="err">This server no longer exists.</Notice>
        <Button variant="outline" onClick={() => navigate("servers")}>Back to MCP servers</Button>
      </div>
    );
  }

  const providerName = providers.find((p) => p.id === server.providerId)?.name ?? "Browser sign-in";
  const canSignIn = server.authMode === "oauth" && server.enabled && (server.status === "not_connected" || server.status === "reconnect");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("servers")}>
          <ArrowLeft className="size-4" />
          All MCP servers
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Logo id={server.slug} size={52} />
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">{server.name}</h2>
          <p className="text-sm text-muted-foreground">
            <code className="text-xs">{server.slug}</code> · {server.authMode === "oauth" ? `Browser sign-in · ${providerName}` : "Shared"}
            {server.isSystem ? " · system" : ""}
          </p>
        </div>
        <Pill tone={chipTone(server)}>{yourConnection(server)}</Pill>
      </div>

      <Tabs value={tab} onValueChange={(t) => navigate(`servers/${server.id}/${t}`)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tools">Tools ({server.tools.length})</TabsTrigger>
          {canManage && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>
      </Tabs>

      {error && <Notice tone="err">{error}</Notice>}

      {tab === "overview" && (
        <Panel title="Overview">
          <Field label="Address">
            <code className="text-xs">{server.url}</code>
          </Field>
          <Field label="Your connection">{yourConnection(server)}</Field>
          <Field label="Sign-in">{server.authMode === "oauth" ? providerName : server.hasCredential ? `Shared credential in ${server.authHeader ?? "Authorization"}` : "No sign-in"}</Field>
          <Field label="Tools">{server.tools.length} listed</Field>

          <div className="flex flex-wrap gap-2 pt-2">
            {canSignIn && (
              <Button asChild>
                <a href={`/api/oauth/server/${server.id}/start`}>Connect your {server.name} account</a>
              </Button>
            )}
            {server.authMode === "oauth" && server.status === "connected" && (
              <Button variant="outline" disabled={busy} onClick={() => act(() => api("DELETE", `/api/oauth/server/${server.id}`))}>
                Disconnect your account
              </Button>
            )}
          </div>

          {canManage && (
            <div className="flex flex-wrap items-center gap-6 border-t pt-4">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={server.chatEnabled} disabled={busy} onCheckedChange={() => act(() => api("PATCH", `/api/servers/${server.id}`, { chatEnabled: !server.chatEnabled }))} />
                Use in chat agent
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={server.enabled} disabled={busy} onCheckedChange={() => act(() => api("PATCH", `/api/servers/${server.id}`, { enabled: !server.enabled }))} />
                {server.enabled ? "Turned on" : "Turned off"}
              </label>
              <Button variant="destructive" size="sm" className="ml-auto" disabled={busy} onClick={() => setConfirmRemove(true)}>
                Remove server
              </Button>
            </div>
          )}
          {server.status === "unreachable" && server.error && <Notice tone="err">{server.error}</Notice>}
        </Panel>
      )}

      {tab === "tools" && (
        <Panel title="Tools" description={server.authMode === "oauth" ? undefined : undefined}>
          {server.tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">{server.authMode === "oauth" ? "Tools appear here after you connect your account." : "This server lists no tools."}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Rule</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {server.tools.map((t) => (
                  <TableRow key={t.name}>
                    <TableCell>
                      <code className="text-xs">{t.name}</code>
                      <div className="text-xs text-muted-foreground">{t.description.replace(/^\[[^\]]*\]\s*/, "").slice(0, 120)}</div>
                    </TableCell>
                    <TableCell>
                      <ClassBadge value={t.class} />
                    </TableCell>
                    <TableCell>
                      {canTools ? (
                        <Select
                          value={t.override}
                          disabled={busy}
                          onValueChange={(v) => act(() => api("PUT", `/api/servers/${server.id}/tools`, { tool: t.name.slice(server.slug.length + 2), access: v }))}
                        >
                          <SelectTrigger size="sm" className="w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Automatic</SelectItem>
                            <SelectItem value="read">Read</SelectItem>
                            <SelectItem value="write">Write</SelectItem>
                            <SelectItem value="blocked">Blocked</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t.override === "auto" ? "Automatic" : t.override}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      )}

      {tab === "settings" && canManage && (
        <Panel title="Settings" description="Change the name, address or credential. The sign-in type can't change after creation.">
          <div>
            <Button onClick={() => setEditing(true)}>Edit server</Button>
          </div>
        </Panel>
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
      <ConfirmDialog
        open={confirmRemove}
        title="Remove this server?"
        body={`${server.name} will be removed from the gateway. Members will lose access to its tools.`}
        confirmLabel="Remove server"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          act(async () => {
            await api("DELETE", `/api/servers/${server.id}`);
            navigate("servers");
          });
        }}
      />
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

function chipTone(s: ServerView): Tone {
  if (s.status === "connected") return "ok";
  if (s.status === "not_connected" || s.status === "reconnect") return "warn";
  if (s.status === "unreachable") return "danger";
  return "muted";
}
