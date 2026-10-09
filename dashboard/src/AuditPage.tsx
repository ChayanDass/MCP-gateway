import { useEffect, useState } from "react";
import { api, type AuditRow } from "./api";

export function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api<AuditRow[]>("GET", "/api/audit?limit=200").then(setRows).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <section>
      <h2>Audit log</h2>
      <p className="muted">Every tool call through the gateway, whether from an external client or the chat agent.</p>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Server</th>
            <th>Tool</th>
            <th>Via</th>
            <th>Duration</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.ts).toLocaleString()}</td>
              <td>{r.user_email}</td>
              <td>{r.server_slug}</td>
              <td>
                <code>{r.tool}</code>
              </td>
              <td>{r.source}</td>
              <td>{r.duration_ms} ms</td>
              <td className={r.outcome === "ok" ? "" : "error"} title={r.error ?? ""}>
                {r.outcome}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
