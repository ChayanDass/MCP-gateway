import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type PermissionDef, type RoleView } from "./api";
import { ConfirmDialog, EmptyState, Modal, Notice, Pill } from "./shared";

// Roles bundle permissions. Members get one role. Built-in roles can't be deleted,
// and the Admin role always has every permission.
export function RolesPage() {
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [defs, setDefs] = useState<PermissionDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoleView | "new" | null>(null);
  const [confirm, setConfirm] = useState<RoleView | null>(null);

  function load() {
    api<RoleView[]>("GET", "/api/roles").then(setRoles).catch((e) => setError(e.message));
  }
  useEffect(() => {
    load();
    api<PermissionDef[]>("GET", "/api/permissions").then(setDefs).catch(() => undefined);
  }, []);

  const labelOf = useMemo(() => new Map(defs.map((d) => [d.key, d.label])), [defs]);

  async function remove(r: RoleView) {
    setConfirm(null);
    setError(null);
    try {
      await api("DELETE", `/api/roles/${r.id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the role");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">A role is a named set of permissions. Give members a role, then change the role to change what they can do.</p>
        <Button onClick={() => setEditing("new")}>New role</Button>
      </div>

      {error && <Notice tone="err">{error}</Notice>}

      {roles.length === 0 ? (
        <EmptyState title="No roles yet" />
      ) : (
        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Members</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.name}</span>
                      {r.builtin && <Pill tone="muted">built-in</Pill>}
                    </div>
                    {r.description && <div className="text-xs text-muted-foreground">{r.description}</div>}
                  </TableCell>
                  <TableCell>
                    <div className="flex max-w-xl flex-wrap gap-1">
                      {r.permissions.length === 0 && <span className="text-sm text-muted-foreground">None</span>}
                      {r.permissions.map((p) => (
                        <span key={p} className="rounded border px-1.5 py-0.5 text-xs">
                          {labelOf.get(p) ?? p}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.user_count}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditing(r)} disabled={r.builtin && r.name === "Admin"}>
                        {r.name === "Admin" && r.builtin ? "Locked" : "Edit"}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => setConfirm(r)} disabled={r.builtin}>
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {editing && <RoleForm role={editing === "new" ? null : editing} defs={defs} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}

      <ConfirmDialog
        open={!!confirm}
        title={`Delete the role "${confirm?.name ?? ""}"?`}
        body="Only roles with no members can be deleted. Move their members to another role first."
        confirmLabel="Delete role"
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && remove(confirm)}
      />
    </div>
  );
}

function RoleForm({ role, defs, onClose, onSaved }: { role: RoleView | null; defs: PermissionDef[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<string, PermissionDef[]>();
    for (const d of defs) map.set(d.group, [...(map.get(d.group) ?? []), d]);
    return [...map.entries()];
  }, [defs]);

  function toggle(key: string, on: boolean) {
    const next = new Set(picked);
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { name, description, permissions: [...picked] };
      if (role) await api("PATCH", `/api/roles/${role.id}`, body);
      else await api("POST", "/api/roles", body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the role");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={role ? `Edit ${role.name}` : "New role"} subtitle="Pick what members with this role can do." onClose={onClose} wide>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="role-name">Name</Label>
            <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Store manager" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="role-desc">Description</Label>
            <Input id="role-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this role is for" />
          </div>
        </div>

        {groups.map(([group, items]) => (
          <div key={group} className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPicked(new Set([...picked, ...items.map((d) => d.key)]))}>
                  Select all
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPicked(new Set([...picked].filter((k) => !items.some((d) => d.key === k))))}>
                  Clear
                </Button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {items.map((d) => (
                <label key={d.key} className="flex items-start gap-3 rounded-md border p-3">
                  <Checkbox checked={picked.has(d.key)} onCheckedChange={(v) => toggle(d.key, v === true)} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{d.label}</span>
                    <span className="block text-xs text-muted-foreground">{d.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}

        {error && <Notice tone="err">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : role ? "Save role" : "Create role"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
