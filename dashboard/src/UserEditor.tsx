import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type RoleView, type UserView } from "./api";
import { ConfirmDialog, Notice, Pill } from "./shared";

type Level = "none" | "read" | "write";

interface AccessRow {
  server_id: string;
  slug: string;
  name: string;
  is_system: boolean;
  access: Level;
}

// Everything about one member: profile and role, what servers they can use, password and deletion.
export function UserEditor({ user, isSelf, roles, onChanged, onClose }: { user: UserView; isSelf: boolean; roles: RoleView[]; onChanged: () => void; onClose: () => void }) {
  const [name, setName] = useState(user.name);
  const [roleId, setRoleId] = useState(user.role_id);
  const [access, setAccess] = useState<AccessRow[]>([]);
  const [password, setPassword] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const role = roles.find((r) => r.id === roleId);
  const fullAccess = role?.permissions.includes("servers.full_access") ?? false;

  function loadAccess() {
    api<AccessRow[]>("GET", `/api/users/${user.id}/access`)
      .then(setAccess)
      .catch((e) => setStatus({ kind: "error", text: e.message }));
  }
  useEffect(loadAccess, [user.id]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      setStatus({ kind: "ok", text: label });
      onChanged();
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile() {
    await run("Profile saved.", () => api("PATCH", `/api/users/${user.id}`, { name, roleId }));
  }

  async function setLevel(serverId: string, level: Level) {
    setAccess((rows) => rows.map((r) => (r.server_id === serverId ? { ...r, access: level } : r)));
    await run("Server access saved.", () => api("PUT", `/api/users/${user.id}/access`, { serverId, access: level }));
  }

  async function resetPassword() {
    await run("Password changed. Existing sessions were signed out.", async () => {
      await api("POST", `/api/users/${user.id}/password`, { password });
      setPassword("");
    });
  }

  async function remove() {
    setConfirmDelete(false);
    await run("Member deleted.", () => api("DELETE", `/api/users/${user.id}`));
    onClose();
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h3 className="font-medium">Profile and role</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="u-name">Name</Label>
            <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={roleId} onValueChange={setRoleId} disabled={isSelf}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {role && <p className="text-xs text-muted-foreground">{role.description}</p>}
          </div>
        </div>
        <div>
          <Button onClick={saveProfile} disabled={busy}>
            Save
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="font-medium">Server access</h3>
          <p className="text-sm text-muted-foreground">
            {fullAccess
              ? "This role can use every server, so there is nothing to set here."
              : "System servers (WooCommerce) can be read only or read and write. Third-party servers are either allowed or not, and they keep the permissions their own token grants. Tools blocked by an admin are never allowed."}
          </p>
        </div>
        {!fullAccess && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Server</TableHead>
                <TableHead>Access</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {access.map((row) => (
                <TableRow key={row.server_id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{row.name}</span>
                      <code className="text-xs">{row.slug}</code>
                      <Pill tone={row.is_system ? "ok" : "muted"}>{row.is_system ? "system" : "third-party"}</Pill>
                    </div>
                  </TableCell>
                  <TableCell>
                    {row.is_system ? (
                      <Select value={row.access} onValueChange={(v) => setLevel(row.server_id, v as Level)} disabled={busy}>
                        <SelectTrigger size="sm" className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No access</SelectItem>
                          <SelectItem value="read">Read only</SelectItem>
                          <SelectItem value="write">Read and write</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox checked={row.access !== "none"} onCheckedChange={(v) => setLevel(row.server_id, v === true ? "write" : "none")} disabled={busy} />
                        Allowed
                      </label>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="font-medium">Password</h3>
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-sm" type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="new password, 8+ characters" />
          <Button variant="outline" onClick={resetPassword} disabled={busy || password.length < 8}>
            Set password
          </Button>
        </div>
      </section>

      {!isSelf && (
        <div className="border-t pt-4">
          <Button variant="destructive" onClick={() => setConfirmDelete(true)} disabled={busy}>
            Delete member
          </Button>
        </div>
      )}
      {status && <Notice tone={status.kind === "ok" ? "ok" : "err"}>{status.text}</Notice>}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${user.email}?`}
        body="Their audit trail stays in the log, but they can no longer sign in, and their keys stop working."
        confirmLabel="Delete member"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={remove}
      />
    </div>
  );
}
