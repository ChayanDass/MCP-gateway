import { useEffect, useState } from "react";
import { api } from "./api";
import { Logo } from "./Logo";
import { navigate } from "./router";

interface Overview {
  servers: { total: number; enabled: number; connected: number; system: number };
  tools: number;
  calls24h: number;
  errors24h: number;
  denied24h: number;
  members: { active: number; admins: number } | null;
  model: { model: string; provider: string; baseUrl: string } | null;
  recent: { ts: string; user_email: string; server_slug: string; tool: string; source: string; outcome: string; duration_ms: number }[];
}

export function OverviewPage({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api<Overview>("GET", "/api/overview").then(setData).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const stats = [
    { label: "Servers connected", value: `${data.servers.connected}/${data.servers.enabled}`, hint: `${data.servers.total} added to the gateway · for you`, tone: "accent", go: "servers" },
    { label: "Tools available to you", value: String(data.tools), hint: "after permissions", tone: "ok", go: "servers" },
    { label: "Calls, last 24 h", value: String(data.calls24h), hint: `${data.errors24h} failed · ${data.denied24h} denied`, tone: "neutral", go: "audit" },
    isAdmin && data.members
      ? { label: "Active members", value: String(data.members.active), hint: `${data.members.admins} admin${data.members.admins === 1 ? "" : "s"}`, tone: "neutral", go: "members" }
      : { label: "Your access", value: "Member", hint: "per-server rules apply", tone: "neutral", go: "members" },
  ];

  return (
    <div className="overview">
      <div className="stats">
        {stats.map((s) => (
          <button key={s.label} className={`stat ${s.tone}`} onClick={() => navigate(s.go)}>
            <span className="stat-label">{s.label}</span>
            <span className="stat-value">{s.value}</span>
            <span className="stat-hint">{s.hint}</span>
          </button>
        ))}
      </div>

      <div className="split">
        <section className="card">
          <div className="card-head">
            <h3>Model in use</h3>
            {isAdmin && (
              <button className="ghost-dark small-btn" onClick={() => navigate("model")}>
                Change
              </button>
            )}
          </div>
          {!isAdmin ? (
            <p className="muted">The chat agent uses the team's configured model.</p>
          ) : data.model ? (
            <div className="model-row">
              <Logo id={data.model.provider === "anthropic" ? "anthropic" : hostProvider(data.model.baseUrl)} size={40} />
              <div>
                <div className="strong">{data.model.model}</div>
                <div className="muted small">{data.model.baseUrl}</div>
              </div>
            </div>
          ) : (
            <p className="error">No model configured. Chat is disabled.</p>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Quick actions</h3>
          </div>
          <div className="actions">
            <button onClick={() => navigate("connect")}>Connect a client</button>
            <button onClick={() => navigate("chat")}>Open chat</button>
            <button onClick={() => navigate("audit")}>View audit log</button>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>Recent activity</h3>
          <button className="ghost-dark small-btn" onClick={() => navigate("audit")}>
            See all
          </button>
        </div>
        {data.recent.length === 0 ? (
          <p className="muted">No tool calls yet. Connect a client or try the chat.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>User</th>
                <th>Tool</th>
                <th>Via</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r, i) => (
                <tr key={i}>
                  <td className="muted">{new Date(r.ts).toLocaleTimeString()}</td>
                  <td>{r.user_email}</td>
                  <td>
                    <code>
                      {r.server_slug}__{r.tool}
                    </code>
                  </td>
                  <td>{r.source}</td>
                  <td>
                    <span className={r.outcome === "ok" ? "badge read" : r.outcome === "denied" ? "badge write" : "badge blocked"}>{r.outcome}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// Picks a provider badge from the base URL, so the overview shows the right logo.
export function hostProvider(url: string): string {
  if (url.includes("groq")) return "groq";
  if (url.includes("googleapis")) return "gemini";
  if (url.includes("openrouter")) return "openrouter";
  if (url.includes("openai.com")) return "openai";
  if (url.includes("anthropic")) return "anthropic";
  if (url.includes("11434") || url.includes("ollama")) return "ollama";
  return "custom";
}
