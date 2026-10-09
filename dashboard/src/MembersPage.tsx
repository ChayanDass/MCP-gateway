import { useEffect, useState, type FormEvent } from "react";
import { api, type KeyView, type Me, type UserView } from "./api";

// The command a member pastes into Claude Code. Only the gateway URL and the
// member's own key are in it; no upstream credentials.
function connectCommand(key: string): string {
  return `claude mcp add --transport http kube-mcp ${window.location.origin}/mcp --header "Authorization: Bearer ${key}"`;
}

export function MembersPage({ me }: { me: Me }) {
  const isAdmin = me.role === "admin";
  const [users, setUsers] = useState<UserView[]>([]);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [newKey, setNewKey] = useState<{ user: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", name: "", role: "member", password: "" });

  const reload = () => {
    if (isAdmin) api<UserView[]>("GET", "/api/users").then(setUsers).catch((e) => setError(e.message));
    api<KeyView[]>("GET", "/api/keys").then(setKeys).catch((e) => setError(e.message));
  };
  useEffect(reload, [isAdmin]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  async function createUser(e: FormEvent) {
    e.preventDefault();
    await run(() => api("POST", "/api/users", form));
    setForm({ email: "", name: "", role: "member", password: "" });
  }

  async function issue(userId: string, label: string, forUser?: string) {
    setError(null);
    try {
      const r = await api<{ key: string }>("POST", `/api/users/${userId}/keys`, { label });
      setNewKey({ user: forUser ?? me.email, key: r.key });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  return (
    <section>
      {newKey && (
        <div className="card callout">
          <strong>New API key for {newKey.user}</strong>
          <p className="small">Copy it now. It is shown once and only its hash is stored.</p>
          <code className="keybox">{newKey.key}</code>
          <p className="small">Connect Claude Code with this command:</p>
          <pre>{connectCommand(newKey.key)}</pre>
          <div className="row">
            <button onClick={() => navigator.clipboard?.writeText(connectCommand(newKey.key))}>Copy command</button>
            <button onClick={() => setNewKey(null)}>Done</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {isAdmin && (
        <>
          <h2>Members</h2>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Active keys</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td>{u.role}</td>
                  <td>{u.active_keys}</td>
                  <td>{u.disabled ? "Disabled" : "Active"}</td>
                  <td className="row">
                    <button onClick={() => issue(u.id, "dashboard", u.email)}>Issue key</button>
                    {u.id !== me.id && (
                      <button onClick={() => run(() => api("PATCH", `/api/users/${u.id}`, { disabled: !u.disabled }))}>
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form className="card" onSubmit={createUser}>
            <h3>Invite member</h3>
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
            <button type="submit">Create user</button>
          </form>
        </>
      )}

      <h2>My API keys</h2>
      <p className="muted">Use a key as a Bearer token with the gateway URL. Keys are shown once at creation.</p>
      <button onClick={() => issue(me.id, "my key")}>Generate new key</button>
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Prefix</th>
            <th>Created</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.label}</td>
              <td>
                <code>{k.prefix}…</code>
              </td>
              <td>{new Date(k.created_at).toLocaleString()}</td>
              <td>{k.revoked_at ? "Revoked" : "Active"}</td>
              <td>
                {!k.revoked_at && (
                  <button className="danger" onClick={() => run(() => api("DELETE", `/api/keys/${k.id}`))}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
