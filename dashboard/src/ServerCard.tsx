import { useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { api, type ServerView } from "./api";
import { Logo } from "./Logo";
import { navigate } from "./router";
import { StatusBadge } from "./shared";

// A compact server tile for the list page. Everything else lives on the server's page.
export function ServerCard({ server: s, providerName, onChanged }: { server: ServerView; providerName: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const needsSignIn = s.authMode === "oauth" && (s.status === "not_connected" || s.status === "reconnect");
  const connected = s.authMode === "oauth" && s.status === "connected";

  async function disconnect(e: MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    try {
      await api("DELETE", `/api/oauth/server/${s.id}`);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="cursor-pointer gap-3 py-5 transition-colors hover:border-primary/50" role="button" tabIndex={0} onClick={() => navigate(`servers/${s.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`servers/${s.id}`)}>
      <CardHeader className="flex flex-row items-center gap-3">
        <Logo id={s.slug} size={40} />
        <div className="min-w-0">
          <div className="truncate font-semibold">{s.name}</div>
          <div className="truncate text-xs text-muted-foreground">{s.slug}</div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {s.isSystem && <span className="rounded border px-1.5 py-0.5">system</span>}
        <span className="rounded border px-1.5 py-0.5">{s.authMode === "oauth" ? providerName : "Shared"}</span>
      </CardContent>
      <CardContent className="flex flex-wrap items-center gap-2">
        <StatusBadge status={s.status} />
        {needsSignIn && s.enabled && (
          <Button asChild size="sm" onClick={(e) => e.stopPropagation()}>
            <a href={`/api/oauth/server/${s.id}/start`}>Connect</a>
          </Button>
        )}
        {connected && (
          <Button variant="outline" size="sm" disabled={busy} onClick={disconnect}>
            Disconnect
          </Button>
        )}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">{s.enabled ? `${s.toolCount ?? s.tools.length} tools` : "Turned off"}</CardFooter>
    </Card>
  );
}
