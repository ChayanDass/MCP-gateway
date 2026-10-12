import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { api } from "./api";
import { CLIENTS, copyText, oauthSnippetFor, snippetFor, type ClientId } from "./connect";
import { Logo } from "./Logo";
import { EmptyState, Notice, Panel } from "./shared";

type Method = "key" | "oauth";

interface KeyRow {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  revoked_at: string | null;
}

interface ClientRow {
  client_id: string;
  client_name: string;
  connected_at: string;
  expires_at: string;
}

// Clients for the logged-in member only. Pick a client, then a setup: a key you
// create here, or browser sign-in, which needs no key.
export function ClientsPage({ userId }: { userId: string }) {
  const [method, setMethod] = useState<Method>("oauth");
  const [client, setClient] = useState<ClientId>("claude-code");
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [connected, setConnected] = useState<ClientRow[]>([]);
  const [label, setLabel] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function load() {
    api<KeyRow[]>("GET", `/api/users/${userId}/keys`).then(setKeys).catch(() => undefined);
    api<ClientRow[]>("GET", `/api/users/${userId}/clients`).then(setConnected).catch(() => undefined);
  }
  useEffect(load, [userId]);

  async function generate() {
    setStatus(null);
    try {
      const r = await api<{ key: string }>("POST", `/api/users/${userId}/keys`, { label: label.trim() || "api key" });
      setNewKey(r.key);
      setLabel("");
      load();
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Could not create the key" });
    }
  }

  async function revoke(id: string) {
    try {
      await api("DELETE", `/api/keys/${id}`);
      load();
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Could not revoke the key" });
    }
  }

  async function disconnect(clientId: string) {
    try {
      await api("DELETE", `/api/users/${userId}/clients/${clientId}`);
      load();
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Could not disconnect" });
    }
  }

  const snippet = method === "key" ? snippetFor(client, newKey ?? "<your-key>") : oauthSnippetFor(client);
  const steps = method === "key" ? KEY_STEPS : OAUTH_STEPS;
  const activeKeys = keys.filter((k) => !k.revoked_at);

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <aside className="space-y-2">
        <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Choose a client</p>
        {CLIENTS.map((c) => (
          <button
            key={c.id}
            onClick={() => setClient(c.id)}
            className={cn("flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/60", client === c.id && "border-primary bg-accent")}
          >
            <Logo id={c.id} size={34} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{c.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{CLIENT_HINT[c.id]}</span>
            </span>
          </button>
        ))}
      </aside>

      <div className="min-w-0 space-y-5">
        <Tabs value={method} onValueChange={(v) => setMethod(v as Method)}>
          <TabsList>
            <TabsTrigger value="oauth">Browser sign-in</TabsTrigger>
            <TabsTrigger value="key">API key</TabsTrigger>
          </TabsList>
        </Tabs>

        {method === "key" && (
          <Panel title="Create a key">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1 space-y-2">
                <Label htmlFor="key-label">Key label</Label>
                <Input id="key-label" placeholder="e.g. laptop" value={label} onChange={(e) => setLabel(e.target.value)} />
              </div>
              <Button onClick={generate}>Generate key</Button>
            </div>
            {newKey && (
              <div className="space-y-2 rounded-md border border-warning/40 bg-warning-soft p-3">
                <p className="text-sm">Copy it now. It is shown once.</p>
                <code className="block break-all rounded bg-background p-2 text-xs">{newKey}</code>
              </div>
            )}
          </Panel>
        )}

        <Panel
          title={method === "key" ? "Manual setup" : "Browser sign-in"}
          description={snippet.title}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                setCopied(await copyText(snippet.body));
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          }
        >
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-xs">{snippet.body}</pre>
          {snippet.note && <p className="text-sm text-muted-foreground">{snippet.note}</p>}
        </Panel>

        {status && <Notice tone={status.kind === "ok" ? "ok" : "err"}>{status.text}</Notice>}

        <Panel title={method === "key" ? "Your keys" : "Your connected clients"}>
          {method === "key" ? (
            activeKeys.length === 0 ? (
              <EmptyState title="No active keys" body="Generate a key above to use with a client that needs one." />
            ) : (
              <Card className="overflow-hidden p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Label</TableHead>
                      <TableHead>Key</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activeKeys.map((k) => (
                      <TableRow key={k.id}>
                        <TableCell>{k.label}</TableCell>
                        <TableCell>
                          <code className="text-xs">{k.prefix}…</code>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{new Date(k.created_at).toLocaleDateString()}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="destructive" size="sm" onClick={() => revoke(k.id)}>
                            Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            )
          ) : connected.length === 0 ? (
            <EmptyState title="No connected clients" body="No client is signed in through browser sign-in yet." />
          ) : (
            <Card className="overflow-hidden p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Connected</TableHead>
                    <TableHead>Session ends</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connected.map((c) => (
                    <TableRow key={c.client_id}>
                      <TableCell className="font-medium">{c.client_name}</TableCell>
                      <TableCell className="text-muted-foreground">{new Date(c.connected_at).toLocaleString()}</TableCell>
                      <TableCell className="text-muted-foreground">{new Date(c.expires_at).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="destructive" size="sm" onClick={() => disconnect(c.client_id)}>
                          Disconnect
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </Panel>
      </div>
    </div>
  );
}

const CLIENT_HINT: Record<ClientId, string> = {
  "claude-code": "Terminal command",
  cursor: "mcp.json",
  vscode: ".vscode/mcp.json",
  codex: "config.toml",
  inspector: "Browser UI",
  other: "URL and header",
};

const KEY_STEPS = [
  "Enter a label and click Generate key. Copy the key shown.",
  "Paste the command or config below into your client, in place of <your-key>.",
  "Restart the client, or reload its MCP servers.",
  "Keep the key private. Revoke it here if it leaks.",
];

const OAUTH_STEPS = [
  "Paste the command or config below into your client. It has no key.",
  "Start the kube-mcp server in your client.",
  "Your browser opens the gateway sign-in page. Sign in with your team account.",
  "Click Allow once. The client gets its own token, which renews itself.",
];
