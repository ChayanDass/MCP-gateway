import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, can, type Me } from "./api";
import { Logo } from "./Logo";
import { navigate } from "./router";
import { ClassBadge, EmptyState, Loading, Panel } from "./shared";

interface Overview {
  servers: { total: number; enabled: number; connected: number; system: number };
  tools: number;
  calls24h: number;
  errors24h: number;
  denied24h: number;
  members: { active: number; admins: number } | null;
  model: { model: string; provider: string; baseUrl: string } | null;
  recent: { ts: string; user_email: string; server_slug: string; tool: string; source: string; outcome: string; duration_ms: number }[];
}

export function OverviewPage({ me }: { me: Me }) {
  const canModel = can(me, "model.manage");
  const canMembers = can(me, "members.manage");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const requestInFlight = useRef(false);

  const load = useCallback(async (background = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    if (!background) setRefreshing(true);
    try {
      const next = await api<Overview>("GET", "/api/overview");
      setData(next);
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load overview");
    } finally {
      requestInFlight.current = false;
      if (!background) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!data && error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-5" role="alert">
        <p className="font-medium">Overview could not be loaded</p>
        <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        <Button className="mt-4" variant="outline" onClick={() => void load()} disabled={refreshing}>
          <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} /> Try again
        </Button>
      </div>
    );
  }

  if (!data) return <Loading lines={7} />;

  const stats = [
    { label: "Servers connected", value: `${data.servers.connected}/${data.servers.enabled}`, hint: `${data.servers.total} added · for you`, go: "servers" },
    { label: "Tools available to you", value: String(data.tools), hint: "After permission rules", go: "servers" },
    { label: "Calls, last 24 hours", value: String(data.calls24h), hint: `${data.errors24h} failed · ${data.denied24h} denied`, go: "security/audit" },
    canMembers && data.members
      ? { label: "Active members", value: String(data.members.active), hint: `${data.members.admins} admin${data.members.admins === 1 ? "" : "s"}`, go: "security/members" }
      : { label: "Your role", value: me.role, hint: "Per-server rules apply", go: "overview" },
  ];

  return (
    <div className="space-y-6" aria-busy={refreshing}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Refreshing overview…"}
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
          <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
          <span>Showing the last loaded data. Refresh failed: {error}</span>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={refreshing}>Retry</Button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <button
            key={s.label}
            type="button"
            className="group rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => navigate(s.go)}
            aria-label={`${s.label}: ${s.value}. ${s.hint}. Open details.`}
          >
            <Card className="h-full gap-2 py-5 transition-colors group-hover:border-primary/50 group-focus-visible:border-primary">
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">{s.label}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                <div className="break-words text-2xl font-semibold tracking-tight">{s.value}</div>
                <div className="text-xs text-muted-foreground">{s.hint}</div>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Model in use" actions={canModel && <Button variant="outline" size="sm" onClick={() => navigate("settings/model")}>Change</Button>}>
          {data.model ? (
            <div className="flex items-center gap-3">
              <Logo id={data.model.provider === "anthropic" ? "anthropic" : hostProvider(data.model.baseUrl)} size={40} />
              <div className="min-w-0">
                <div className="truncate font-medium">{data.model.model}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {data.model.provider === "anthropic" ? "Anthropic" : "OpenAI-compatible"} · {data.model.baseUrl}
                </div>
              </div>
            </div>
          ) : canModel ? (
            <p className="text-sm text-destructive">No model configured. Chat is disabled.</p>
          ) : (
            <p className="text-sm text-muted-foreground">No model is set yet. Ask an admin to choose one in Settings.</p>
          )}
        </Panel>

        <Panel title="Quick actions">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => navigate("clients")}>Connect a client</Button>
            <Button variant="outline" onClick={() => navigate("chat")}>Open chat</Button>
            <Button variant="outline" onClick={() => navigate("security/audit")}>View audit log</Button>
          </div>
        </Panel>
      </div>

      <Panel title="Recent activity" description="The latest tool calls recorded by the gateway." actions={<Button variant="ghost" size="sm" onClick={() => navigate("security/audit")}>See all</Button>}>
        {data.recent.length === 0 ? (
          <EmptyState title="No tool calls yet" body="Connect a client or try the chat to see activity here." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Tool</TableHead>
                  <TableHead>Via</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recent.map((r, i) => (
                  <TableRow key={`${r.ts}-${r.user_email}-${r.server_slug}-${r.tool}-${i}`}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(r.ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</TableCell>
                    <TableCell className="max-w-48 truncate">{r.user_email}</TableCell>
                    <TableCell><code className="break-all text-xs">{r.server_slug}__{r.tool}</code></TableCell>
                    <TableCell>{r.source}</TableCell>
                    <TableCell><ClassBadge value={r.outcome === "ok" ? "allowed" : r.outcome === "denied" ? "denied" : "blocked"} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// Picks a provider badge from the base URL, so the overview shows the right logo.
export function hostProvider(url: string): string {
  if (url.includes("groq")) return "groq";
  if (url.includes("googleapis")) return "gemini";
  if (url.includes("openrouter")) return "openrouter";
  if (url.includes("openai.com")) return "openai";
  if (url.includes("anthropic")) return "anthropic";
  if (url.includes("11434") || url.includes("ollama")) return "ollama";
  return "custom";
}
