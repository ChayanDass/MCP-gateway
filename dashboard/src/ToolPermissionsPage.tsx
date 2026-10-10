import { useEffect, useMemo, useState } from "react";
import { api, type UserView } from "./api";
import { Logo } from "./Logo";

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
// inherit (the default), allow, or deny. The result column shows what the member
// can actually call.
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
    <div className="split-page">
      <aside className="people">
        <div className="client-nav-title">Members</div>
        {users.map((u) => (
          <button key={u.id} className={`client-tile ${selected === u.id ? "selected" : ""}`} onClick={() => setSelected(u.id)}>
            <Logo id={u.role === "admin" ? "custom" : "other"} size={34} />
            <span className="client-tile-text">
              <span className="client-tile-name">{u.name}</span>
              <span className="muted small">{u.email}</span>
            </span>
          </button>
        ))}
      </aside>

      <section className="people-main">
        {error && <p className="status-line err">{error}</p>}
        {!member && <p className="muted">Choose a member.</p>}
        {member && member.role === "admin" && (
          <p className="status-line ok">Admins have every tool. Rules below only apply to members.</p>
        )}
        {member && !blocks && <p className="muted">Loading…</p>}
        {member &&
          blocks?.map((b) => (
            <div key={b.serverId} className="card">
              <div className="card-head">
                <div className="row">
                  <Logo id={b.slug} size={28} />
                  <strong>{b.name}</strong>
                  <span className={b.isSystem ? "badge read" : "badge"}>{b.isSystem ? "system" : "third-party"}</span>
                  <span className="badge">{b.level === "none" ? "No access" : b.level === "read" ? "Read only" : "Read and write"}</span>
                </div>
              </div>
              {b.level === "none" && <p className="muted small">{member.name} has no access to this server. Grant access under Members first.</p>}
              {b.tools.length === 0 ? (
                <p className="muted small">
                  {b.authMode === "oauth" ? "Tools appear here after a member connects this account." : "No tools reported by this server."}
                </p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>Class</th>
                      <th>Rule</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.tools.map((t) => (
                      <tr key={t.name}>
                        <td>
                          <code>{t.name}</code>
                          {t.description && <div className="muted small">{t.description.slice(0, 90)}</div>}
                        </td>
                        <td>
                          <span className={`badge ${t.class}`}>{t.class}</span>
                        </td>
                        <td>
                          <div className="rule-seg" role="group" aria-label={`Rule for ${t.name}`}>
                            {(["inherit", "allow", "deny"] as Rule[]).map((r) => (
                              <button
                                key={r}
                                className={`${t.rule === r ? "on" : ""} ${r}`}
                                disabled={busy === `${b.serverId}|${t.name}` || member.role === "admin"}
                                onClick={() => setRule(b.serverId, t.name, r)}
                              >
                                {r === "inherit" ? "Default" : r === "allow" ? "Allow" : "Deny"}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td>
                          <span className={t.allowed ? "badge read" : "badge blocked"}>{t.allowed ? "Allowed" : "Blocked"}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
      </section>
    </div>
  );
}
