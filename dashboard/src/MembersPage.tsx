import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Me, type ServerView, type UserView } from "./api";
import { UserEditor } from "./UserEditor";
import { Modal, Notice, Pill, Panel } from "./shared";

// Admin only: create members, give and revoke their access, disable or delete them.
export function MembersPage({ me }: { me: Me }) {
  const [users, setUsers] = useState<UserView[]>([]);
  const [servers, setServers] = useState<ServerView[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", name: "", role: "member", password: "" });
  const [grants, setGrants] = useState<Record<string, "none" | "read" | "write">>({});

  function reload() {
    api<UserView[]>("GET", "/api/users").then(setUsers).catch((e) => setError(e.message));
    api<ServerView[]>("GET", "/api/servers").then(setServers).catch(() => undefined);
  }
  useEffect(reload, []);

  const visible = useMemo(() => users.filter((u) => (u.name + " " + u.email).toLowerCase().includes(query.toLowerCase())), [users, query]);
  const selected = users.find((u) => u.id === editing);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("POST", "/api/users", { ...form, access: grants });
      setForm({ email: "", name: "", role: "member", password: "" });
      setGrants({});
      setCreating(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the member");
    }
  }

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
        <Panel title="New member">
          <form className="space-y-5" onSubmit={createUser}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="m-name">Name</Label>
                <Input id="m-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="m-email">Email</Label>
                <Input id="m-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="m-pass">Initial password</Label>
                <Input id="m-pass" type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
              </div>
            </div>

            {form.role === "member" && (
              <div className="space-y-3">
                <Label>Access</Label>
                <div className="grid gap-3 sm:grid-cols-2">
                  {servers.map((sv) =>
                    sv.isSystem ? (
                      <div key={sv.id} className="space-y-2">
                        <Label className="text-sm font-normal">
                          {sv.name} <code className="text-xs">{sv.slug}</code>
                        </Label>
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
                      </div>
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
              <Button type="submit">Create member</Button>
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
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{u.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                    </div>
                    {u.id === me.id && <Pill tone="muted">you</Pill>}
                  </div>
                </TableCell>
                <TableCell>
                  <Pill tone={u.role === "admin" ? "warn" : "muted"}>{u.role}</Pill>
                </TableCell>
                <TableCell>
                  <Pill tone={u.disabled ? "danger" : "ok"}>{u.disabled ? "Disabled" : "Active"}</Pill>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="outline" size="sm" onClick={() => setEditing(u.id)}>
                    Permissions
                  </Button>
                </TableCell>
              </TableRow>
            ))}
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

      {selected && (
        <Modal title={`Permissions: ${selected.name || selected.email}`} subtitle={selected.email} onClose={() => setEditing(null)} wide>
          <UserEditor key={selected.id} user={selected} isSelf={selected.id === me.id} onChanged={reload} onClose={() => setEditing(null)} />
        </Modal>
      )}
    </div>
  );
}
