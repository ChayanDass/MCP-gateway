import { useEffect, useState } from "react";
import { api, type ServerView, type UserView } from "./api";
import { ConfirmDialog } from "./ui";

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
    <>
    <div className="card">
      <div className="row between">
        <strong>Edit {user.email}</strong>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="grid">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")} disabled={isSelf}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label className="row small">
          <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} disabled={isSelf} />
          Disabled (cannot sign in or call tools)
        </label>
      </div>
      <button onClick={saveProfile} disabled={busy}>
        Save profile
      </button>

      <h3>Access per server</h3>
      <p className="small muted">
        System servers (WooCommerce) can be read only or read and write. Third-party servers are either allowed or not, and they
        keep the permissions their own token grants. Tools blocked by an admin are never allowed. Admins always have full access.
      </p>
      <table>
        <thead>
          <tr>
            <th>Server</th>
            <th>Access</th>
          </tr>
        </thead>
        <tbody>
          {access.map((row) => (
            <tr key={row.server_id}>
              <td>
                <div className="row">
                  <strong>{row.name}</strong>
                  <code>{row.slug}</code>
                  <span className={row.is_system ? "badge read" : "badge"}>{row.is_system ? "system" : "third-party"}</span>
                </div>
              </td>
              <td>
                {row.is_system ? (
                  <select value={row.access} onChange={(e) => setLevel(row.server_id, e.target.value as Level)} disabled={busy || role === "admin"}>
                    <option value="none">No access</option>
                    <option value="read">Read only</option>
                    <option value="write">Read and write</option>
                  </select>
                ) : (
                  <label className="row check">
                    <input
                      type="checkbox"
                      checked={row.access !== "none"}
                      onChange={(e) => setLevel(row.server_id, e.target.checked ? "write" : "none")}
                      disabled={busy || role === "admin"}
                    />
                    Allowed
                  </label>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {role === "admin" && <p className="small muted">Admins have full access to every server.</p>}

      <h3>Password</h3>
      <div className="row">
        <input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="new password, 8+ characters" />
        <button onClick={resetPassword} disabled={busy || password.length < 8}>
          Set password
        </button>
      </div>

      {!isSelf && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
            Delete user
          </button>
        </div>
      )}
      {status && <p className={status.kind === "ok" ? "small" : "error small"}>{status.text}</p>}
    </div>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${user.email}?`}
        body="Their keys and audit trail stay in the log, but they can no longer sign in."
        confirmLabel="Delete user"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={remove}
      />
    </>
  );
}

export type { ServerView };
