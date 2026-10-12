import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { api, type UserView } from "./api";
import { Logo } from "./Logo";
import { ClassBadge, EmptyState, Notice, Panel, Pill } from "./shared";

type Rule = "inherit" | "allow" | "deny";

interface ToolRow {
  name: string;
  description: string;
  class: "read" | "write" | "blocked";
  rule: Rule;
  allowed: boolean;
}

interface ServerBlock {
  serverId: string;
  slug: string;
  name: string;
  authMode: "static" | "oauth";
  isSystem: boolean;
  level: "none" | "read" | "write";
  tools: ToolRow[];
}

// Per-member tool permissions. Pick a member on the left; each tool gets a rule:
// default (the default), allow, or deny. The result column shows what the member can call.
export function ToolPermissionsPage() {
  const [users, setUsers] = useState<UserView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<ServerBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<UserView[]>("GET", "/api/users")
      .then((u) => {
        setUsers(u);
        setSelected((cur) => cur ?? u[0]?.id ?? null);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setBlocks(null);
    api<ServerBlock[]>("GET", `/api/users/${selected}/tool-access`)
      .then(setBlocks)
      .catch((e) => setError(e.message));
  }, [selected]);

  const member = useMemo(() => users.find((u) => u.id === selected), [users, selected]);

  async function setRule(serverId: string, tool: string, access: Rule) {
    if (!selected) return;
    const key = `${serverId}|${tool}`;
    setBusy(key);
    setError(null);
    try {
      await api("PUT", `/api/users/${selected}/tool-access`, { serverId, tool, access });
      setBlocks(await api<ServerBlock[]>("GET", `/api/users/${selected}/tool-access`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the rule");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <aside className="space-y-2">
        <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Members</p>
        {users.map((u) => (
          <button
            key={u.id}
            onClick={() => setSelected(u.id)}
            className={cn("flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/60", selected === u.id && "border-primary bg-accent")}
          >
            <Logo id={u.role === "admin" ? "custom" : "other"} size={34} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{u.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{u.email}</span>
            </span>
          </button>
        ))}
      </aside>

      <section className="min-w-0 space-y-5">
        {error && <Notice tone="err">{error}</Notice>}
        {!member && <EmptyState title="Choose a member" />}
        {member && member.role === "admin" && <Notice tone="ok">Admins have every tool. Rules below only apply to members.</Notice>}
        {member && !blocks && <p className="text-sm text-muted-foreground">Loading…</p>}
        {member &&
          blocks?.map((b) => (
            <Panel
              key={b.serverId}
              title={b.name}
              actions={
                <div className="flex items-center gap-2">
                  <Logo id={b.slug} size={24} />
                  <Pill tone={b.isSystem ? "ok" : "muted"}>{b.isSystem ? "system" : "third-party"}</Pill>
                  <Pill tone="muted">{b.level === "none" ? "No access" : b.level === "read" ? "Read only" : "Read and write"}</Pill>
                </div>
              }
            >
              {b.level === "none" && <p className="text-sm text-muted-foreground">{member.name} has no access to this server. Grant access under Members first.</p>}
              {b.tools.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {b.authMode === "oauth" ? "Tools appear here after a member connects this account." : "No tools reported by this server."}
                </p>
              ) : (
                <Card className="overflow-hidden p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tool</TableHead>
                        <TableHead>Class</TableHead>
                        <TableHead>Rule</TableHead>
                        <TableHead>Result</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {b.tools.map((t) => (
                        <TableRow key={t.name}>
                          <TableCell>
                            <code className="text-xs">{t.name}</code>
                            {t.description && <div className="text-xs text-muted-foreground">{t.description.slice(0, 90)}</div>}
                          </TableCell>
                          <TableCell>
                            <ClassBadge value={t.class} />
                          </TableCell>
                          <TableCell>
                            <ToggleGroup
                              type="single"
                              variant="outline"
                              size="sm"
                              value={t.rule}
                              disabled={busy === `${b.serverId}|${t.name}` || member.role === "admin"}
                              onValueChange={(v) => v && setRule(b.serverId, t.name, v as Rule)}
                              aria-label={`Rule for ${t.name}`}
                            >
                              <ToggleGroupItem value="inherit">Default</ToggleGroupItem>
                              <ToggleGroupItem value="allow">Allow</ToggleGroupItem>
                              <ToggleGroupItem value="deny">Deny</ToggleGroupItem>
                            </ToggleGroup>
                          </TableCell>
                          <TableCell>
                            <ClassBadge value={t.allowed ? "allowed" : "blocked"} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              )}
            </Panel>
          ))}
      </section>
    </div>
  );
}
