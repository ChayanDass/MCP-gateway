import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "./api";
import { Logo } from "./Logo";
import { navigate } from "./router";
import { ClassBadge, EmptyState, Panel } from "./shared";

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

export function OverviewPage({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api<Overview>("GET", "/api/overview").then(setData).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const stats = [
    { label: "Servers connected", value: `${data.servers.connected}/${data.servers.enabled}`, hint: `${data.servers.total} added · for you`, go: "servers" },
    { label: "Tools available to you", value: String(data.tools), hint: "after permissions", go: "servers" },
    { label: "Calls, last 24 h", value: String(data.calls24h), hint: `${data.errors24h} failed · ${data.denied24h} denied`, go: "security/audit" },
    isAdmin && data.members
      ? { label: "Active members", value: String(data.members.active), hint: `${data.members.admins} admin${data.members.admins === 1 ? "" : "s"}`, go: "security/members" }
      : { label: "Your access", value: "Member", hint: "per-server rules apply", go: "security/members" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="cursor-pointer gap-2 py-5 transition-colors hover:border-primary/50" onClick={() => navigate(s.go)}>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">{s.label}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <div className="text-2xl font-semibold tracking-tight">{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.hint}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Model in use"
          actions={isAdmin && <Button variant="outline" size="sm" onClick={() => navigate("settings/model")}>Change</Button>}
        >
          {!isAdmin ? (
            <p className="text-sm text-muted-foreground">The chat agent uses the team's configured model.</p>
          ) : data.model ? (
            <div className="flex items-center gap-3">
              <Logo id={data.model.provider === "anthropic" ? "anthropic" : hostProvider(data.model.baseUrl)} size={40} />
              <div className="min-w-0">
                <div className="truncate font-medium">{data.model.model}</div>
                <div className="truncate text-xs text-muted-foreground">{data.model.baseUrl}</div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-destructive">No model configured. Chat is disabled.</p>
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

      <Panel title="Recent activity" actions={<Button variant="ghost" size="sm" onClick={() => navigate("security/audit")}>See all</Button>}>
        {data.recent.length === 0 ? (
          <EmptyState title="No tool calls yet" body="Connect a client or try the chat." />
        ) : (
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
                <TableRow key={i}>
                  <TableCell className="text-muted-foreground">{new Date(r.ts).toLocaleTimeString()}</TableCell>
                  <TableCell>{r.user_email}</TableCell>
                  <TableCell>
                    <code className="text-xs">{r.server_slug}__{r.tool}</code>
                  </TableCell>
                  <TableCell>{r.source}</TableCell>
                  <TableCell>
                    <ClassBadge value={r.outcome === "ok" ? "allowed" : r.outcome === "denied" ? "denied" : "blocked"} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
