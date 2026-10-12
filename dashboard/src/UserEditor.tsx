import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type UserView } from "./api";
import { ConfirmDialog, Notice, Pill } from "./shared";

type Level = "none" | "read" | "write";

interface AccessRow {
  server_id: string;
  slug: string;
  name: string;
  is_system: boolean;
  access: Level;
}

// Full control over one member: profile, role, disabled state, access per server,
// password reset and deletion. Admins only.
export function UserEditor({ user, isSelf, onChanged, onClose }: { user: UserView; isSelf: boolean; onChanged: () => void; onClose: () => void }) {
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState(user.role);
  const [disabled, setDisabled] = useState(user.disabled);
  const [access, setAccess] = useState<AccessRow[]>([]);
  const [password, setPassword] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AccessRow[]>("GET", `/api/users/${user.id}/access`)
      .then(setAccess)
      .catch((e) => setStatus({ kind: "error", text: e.message }));
  }, [user.id]);

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
    await run("Profile saved.", () => api("PATCH", `/api/users/${user.id}`, { name, role, disabled }));
  }

  async function setLevel(serverId: string, level: Level) {
    setAccess((rows) => rows.map((r) => (r.server_id === serverId ? { ...r, access: level } : r)));
    await run("Access saved.", () => api("PUT", `/api/users/${user.id}/access`, { serverId, access: level }));
  }

  async function resetPassword() {
    await run("Password changed. Existing sessions were signed out.", async () => {
      await api("POST", `/api/users/${user.id}/password`, { password });
      setPassword("");
    });
  }

  async function remove() {
    setConfirmDelete(false);
    await run("User deleted.", () => api("DELETE", `/api/users/${user.id}`));
    onClose();
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="u-name">Name</Label>
            <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "admin" | "member")} disabled={isSelf}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={disabled} onCheckedChange={(v) => setDisabled(v === true)} disabled={isSelf} />
          Disabled (cannot sign in or call tools)
        </label>
        <div>
          <Button onClick={saveProfile} disabled={busy}>
            Save profile
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="font-medium">Access per server</h3>
          <p className="text-sm text-muted-foreground">
            System servers (WooCommerce) can be read only or read and write. Third-party servers are either allowed or not, and they keep the permissions their
            own token grants. Tools blocked by an admin are never allowed. Admins always have full access.
          </p>
        </div>
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
                    <Select value={row.access} onValueChange={(v) => setLevel(row.server_id, v as Level)} disabled={busy || role === "admin"}>
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
                      <Checkbox
                        checked={row.access !== "none"}
                        onCheckedChange={(v) => setLevel(row.server_id, v === true ? "write" : "none")}
                        disabled={busy || role === "admin"}
                      />
                      Allowed
                    </label>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {role === "admin" && <p className="text-sm text-muted-foreground">Admins have full access to every server.</p>}
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
            Delete user
          </Button>
        </div>
      )}
      {status && <Notice tone={status.kind === "ok" ? "ok" : "err"}>{status.text}</Notice>}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${user.email}?`}
        body="Their keys and audit trail stay in the log, but they can no longer sign in."
        confirmLabel="Delete user"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={remove}
      />
    </div>
  );
}
