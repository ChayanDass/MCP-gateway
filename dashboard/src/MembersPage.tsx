import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Me, type RoleView, type ServerView, type UserView } from "./api";
import { UserEditor } from "./UserEditor";
import { ConfirmDialog, Modal, Notice, Panel, Pill } from "./shared";

// Members get a role, which decides what they can do. Server access is set per member.
export function MembersPage({ me }: { me: Me }) {
  const [users, setUsers] = useState<UserView[]>([]);
  const [servers, setServers] = useState<ServerView[]>([]);
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [managing, setManaging] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", name: "", roleId: "", password: "" });
  const [grants, setGrants] = useState<Record<string, "none" | "read" | "write">>({});
  const [confirmRevoke, setConfirmRevoke] = useState<UserView | null>(null);

  function reload() {
    api<UserView[]>("GET", "/api/users").then(setUsers).catch((e) => setError(e.message));
    api<ServerView[]>("GET", "/api/servers").then(setServers).catch(() => undefined);
    api<RoleView[]>("GET", "/api/roles").then((r) => {
      setRoles(r);
      setForm((f) => (f.roleId ? f : { ...f, roleId: r.find((x) => x.name === "Member")?.id ?? r[0]?.id ?? "" }));
    }).catch(() => undefined);
  }
  useEffect(reload, []);

  const visible = useMemo(() => users.filter((u) => (u.name + " " + u.email).toLowerCase().includes(query.toLowerCase())), [users, query]);
  const managed = users.find((u) => u.id === managing);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("POST", "/api/users", { ...form, access: grants });
      setForm((f) => ({ ...f, email: "", name: "", password: "" }));
      setGrants({});
      setCreating(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the member");
    }
  }

  async function setAccess(u: UserView, restore: boolean) {
    setError(null);
    try {
      await api("PATCH", `/api/users/${u.id}`, { disabled: !restore });
      setConfirmRevoke(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change access");
    }
  }

  const roleFor = (id: string) => roles.find((r) => r.id === id);
  const memberRole = roles.find((r) => r.id === form.roleId);
  const needsServerGrants = memberRole ? !memberRole.permissions.includes("servers.full_access") : true;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Input className="max-w-sm" placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button className="ml-auto" onClick={() => setCreating((c) => !c)}>
          {creating ? "Close" : "Add member"}
        </Button>
      </div>

      {error && <Notice tone="err">{error}</Notice>}

      {creating && (
        <Panel title="New member" description="Choose a role. Then choose which servers they can use, if their role doesn't give every server.">
          <form className="space-y-5" onSubmit={createUser}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="m-name" label="Name">
                <Input id="m-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </Field>
              <Field id="m-email" label="Email">
                <Input id="m-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              </Field>
              <Field id="m-pass" label="Initial password">
                <Input id="m-pass" type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
              </Field>
              <Field label="Role">
                <Select value={form.roleId} onValueChange={(v) => setForm({ ...form, roleId: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a role" />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {needsServerGrants && (
              <div className="space-y-3">
                <Label>Server access</Label>
                <div className="grid gap-3 sm:grid-cols-2">
                  {servers.map((sv) =>
                    sv.isSystem ? (
                      <Field key={sv.id} label={`${sv.name} (${sv.slug})`}>
                        <Select value={grants[sv.id] ?? "none"} onValueChange={(v) => setGrants({ ...grants, [sv.id]: v as "none" | "read" | "write" })}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No access</SelectItem>
                            <SelectItem value="read">Read only</SelectItem>
                            <SelectItem value="write">Read and write</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                    ) : (
                      <label key={sv.id} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={(grants[sv.id] ?? "none") !== "none"} onCheckedChange={(v) => setGrants({ ...grants, [sv.id]: v ? "write" : "none" })} />
                        {sv.name} <code className="text-xs">{sv.slug}</code>
                      </label>
                    ),
                  )}
                </div>
              </div>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={!form.roleId}>Create member</Button>
            </div>
          </form>
        </Panel>
      )}

      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Access</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((u) => {
              const isSelf = u.id === me.id;
              return (
                <TableRow key={u.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{u.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                      </div>
                      {isSelf && <Pill tone="muted">you</Pill>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Pill tone={roleFor(u.role_id)?.permissions.includes("roles.manage") ? "warn" : "muted"}>{u.role}</Pill>
                  </TableCell>
                  <TableCell>
                    <Pill tone={u.disabled ? "danger" : "ok"}>{u.disabled ? "Revoked" : "Active"}</Pill>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setManaging(u.id)}>
                        Manage
                      </Button>
                      {u.disabled ? (
                        <Button variant="outline" size="sm" onClick={() => setAccess(u, true)} disabled={isSelf}>
                          Restore access
                        </Button>
                      ) : (
                        <Button variant="destructive" size="sm" onClick={() => setConfirmRevoke(u)} disabled={isSelf} title={isSelf ? "You can't revoke your own access" : undefined}>
                          Revoke access
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  No members match your search.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {managed && (
        <Modal title={`Manage ${managed.name || managed.email}`} subtitle={managed.email} onClose={() => setManaging(null)} wide>
          <UserEditor key={managed.id} user={managed} isSelf={managed.id === me.id} roles={roles} onChanged={reload} onClose={() => setManaging(null)} />
        </Modal>
      )}

      <ConfirmDialog
        open={!!confirmRevoke}
        title={`Revoke access for ${confirmRevoke?.name ?? ""}?`}
        body="They can't sign in, and their MCP keys stop working on the next call. Their role, permissions and keys are kept, so you can restore access later."
        confirmLabel="Revoke access"
        onCancel={() => setConfirmRevoke(null)}
        onConfirm={() => confirmRevoke && setAccess(confirmRevoke, false)}
      />
    </div>
  );
}

function Field({ id, label, children }: { id?: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
