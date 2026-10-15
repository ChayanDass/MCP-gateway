import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { api, type UserView } from "./api";
import { Logo } from "./Logo";
import { ClassBadge, EmptyState, Notice, Panel, Pill } from "./shared";

type Rule = "inherit" | "allow" | "deny";
type Filter = "all" | "allowed" | "blocked";

interface ToolRow {
  name: string;
  description: string;
  class: "read" | "write" | "blocked";
  rule: Rule;
  allowed: boolean;
  reason: string;
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

// Who can call which tools. Pick a member; each tool shows whether it's allowed, why,
// and a rule the admin can set. The reason comes from the same check the gateway runs.
export function ToolPermissionsPage() {
  const [users, setUsers] = useState<UserView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<ServerBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

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

  const totals = useMemo(() => {
    const all = (blocks ?? []).flatMap((b) => b.tools);
    return { all: all.length, allowed: all.filter((t) => t.allowed).length };
  }, [blocks]);

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

  const q = query.trim().toLowerCase();
  const shown = (blocks ?? []).map((b) => ({
    ...b,
    tools: b.tools.filter((t) => (filter === "all" || (filter === "allowed") === t.allowed) && (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))),
  }));

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
            <Logo id={u.role === "Admin" ? "custom" : "other"} size={34} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{u.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {u.role} · {u.disabled ? "revoked" : "active"}
              </span>
            </span>
          </button>
        ))}
      </aside>

      <section className="min-w-0 space-y-5">
        {error && <Notice tone="err">{error}</Notice>}
        {!member && <EmptyState title="Choose a member" />}

        {member && (
          <Card className="flex flex-wrap items-center justify-between gap-4 p-4 text-left">
            <div className="min-w-0">
              <div className="font-medium">{member.name}</div>
              <div className="text-sm text-muted-foreground">
                Role <span className="text-foreground">{member.role}</span>
                {member.disabled && <> · access revoked, so no tool is available</>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Pill tone={totals.allowed === totals.all ? "ok" : totals.allowed === 0 ? "danger" : "warn"}>
                {totals.allowed} of {totals.all} tools allowed
              </Pill>
            </div>
          </Card>
        )}

        {member && member.role === "Admin" && <Notice tone="ok">The Admin role can use every tool. Rules below only apply to members with other roles.</Notice>}

        {member && blocks && (
          <div className="flex flex-wrap items-center gap-3">
            <Input className="max-w-xs" placeholder="Search tools" value={query} onChange={(e) => setQuery(e.target.value)} />
            <ToggleGroup type="single" variant="outline" size="sm" value={filter} onValueChange={(v) => v && setFilter(v as Filter)}>
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              <ToggleGroupItem value="allowed">Allowed</ToggleGroupItem>
              <ToggleGroupItem value="blocked">Blocked</ToggleGroupItem>
            </ToggleGroup>
          </div>
        )}

        {member && !blocks && <p className="text-sm text-muted-foreground">Loading…</p>}

        {member &&
          shown.map((b) => (
            <Panel
              key={b.serverId}
              title={b.name}
              description={b.level === "none" && member.role !== "Admin" ? `${member.name} has no access to this server. Grant access under Members first.` : undefined}
              actions={
                <div className="flex items-center gap-2">
                  <Logo id={b.slug} size={24} />
                  <Pill tone={b.isSystem ? "ok" : "muted"}>{b.isSystem ? "system" : "third-party"}</Pill>
                  <Pill tone="muted">{b.level === "none" ? "No access" : b.level === "read" ? "Read only" : "Read and write"}</Pill>
                </div>
              }
            >
              {b.tools.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {b.authMode === "oauth" ? "Tools appear here after a member connects this account." : "No tools match this view."}
                </p>
              ) : (
                <Card className="overflow-x-auto p-0">
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
                          <TableCell className="min-w-56 max-w-sm whitespace-normal">
                            <code className="text-xs">{t.name}</code>
                            {t.description && <div className="line-clamp-2 text-xs text-muted-foreground">{t.description}</div>}
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
                              disabled={busy === `${b.serverId}|${t.name}` || member.role === "Admin"}
                              onValueChange={(v) => v && setRule(b.serverId, t.name, v as Rule)}
                              aria-label={`Rule for ${t.name}`}
                            >
                              <ToggleGroupItem value="inherit">Default</ToggleGroupItem>
                              <ToggleGroupItem value="allow">Allow</ToggleGroupItem>
                              <ToggleGroupItem value="deny">Deny</ToggleGroupItem>
                            </ToggleGroup>
                          </TableCell>
                          <TableCell className="min-w-44 whitespace-normal">
                            <div className="flex flex-col gap-1">
                              <ClassBadge value={t.allowed ? "allowed" : "blocked"} />
                              <span className="text-xs text-muted-foreground">{t.reason}</span>
                            </div>
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
