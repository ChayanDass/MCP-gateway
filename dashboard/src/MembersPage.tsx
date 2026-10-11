import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type Me, type ServerView, type UserView } from "./api";
import { UserEditor } from "./UserEditor";
import { Modal } from "./Modal";

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

  const visible = useMemo(
    () => users.filter((u) => (u.name + " " + u.email).toLowerCase().includes(query.toLowerCase())),
    [users, query],
  );
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
    <div className="members">
      <div className="toolbar">
        <input className="search" placeholder="Search by name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="primary" onClick={() => setCreating((c) => !c)}>
          {creating ? "Close" : "Add member"}
        </button>
      </div>

      {error && <p className="status-line err">{error}</p>}

      {creating && (
        <form className="card" onSubmit={createUser}>
          <div className="card-head">
            <strong>New member</strong>
          </div>
          <div className="grid">
            <label>
              Name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label>
              Email
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </label>
            <label>
              Role
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <label>
              Initial password
              <input type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
            </label>
          </div>
          {form.role === "member" && (
            <>
              <h4>Access</h4>
              <div className="grid">
                {servers.map((sv) =>
                  sv.isSystem ? (
                    <label key={sv.id}>
                      {sv.name} <code>{sv.slug}</code>
                      <select value={grants[sv.id] ?? "none"} onChange={(e) => setGrants({ ...grants, [sv.id]: e.target.value as "none" | "read" | "write" })}>
                        <option value="none">No access</option>
                        <option value="read">Read only</option>
                        <option value="write">Read and write</option>
                      </select>
                    </label>
                  ) : (
                    <label key={sv.id} className="row check">
                      <input
                        type="checkbox"
                        checked={(grants[sv.id] ?? "none") !== "none"}
                        onChange={(e) => setGrants({ ...grants, [sv.id]: e.target.checked ? "write" : "none" })}
                      />
                      {sv.name} <code>{sv.slug}</code>
                    </label>
                  ),
                )}
              </div>
            </>
          )}
          <button type="submit" className="primary">
            Create member
          </button>
        </form>
      )}

      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((u) => (
              <tr key={u.id} className={editing === u.id ? "row-active" : ""}>
                <td>
                  <div className="member-id">
                    <strong>{u.name}</strong>
                    <span className="muted small">{u.email}</span>
                  </div>
                  {u.id === me.id && <span className="badge">you</span>}
                </td>
                <td>
                  <span className={u.role === "admin" ? "badge write" : "badge"}>{u.role}</span>
                </td>
                <td>
                  <span className={u.disabled ? "badge blocked" : "badge read"}>{u.disabled ? "Disabled" : "Active"}</span>
                </td>
                <td className="actions-cell">
                  <button className="small-btn" onClick={() => setEditing(u.id)}>
                    Permissions
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No members match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <Modal title={`Permissions: ${selected.name || selected.email}`} subtitle={selected.email} onClose={() => setEditing(null)} wide>
          <UserEditor key={selected.id} user={selected} isSelf={selected.id === me.id} onChanged={reload} onClose={() => setEditing(null)} />
        </Modal>
      )}
    </div>
  );
}
