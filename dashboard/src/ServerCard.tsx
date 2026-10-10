import { Logo } from "./Logo";
import { api } from "./api";
import { useState } from "react";
import type { ServerView } from "./api";
import { navigate } from "./router";

// A compact server tile for the list page. Everything else lives on the server's page.
export function ServerCard({ server: s, providerName, onChanged }: { server: ServerView; providerName: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const needsSignIn = s.authMode === "oauth" && (s.status === "not_connected" || s.status === "reconnect");
  const connected = s.authMode === "oauth" && s.status === "connected";
  async function disconnect(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    try {
      await api("DELETE", `/api/oauth/server/${s.id}`);
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  const tone = s.status === "connected" ? "ok" : s.status === "not_connected" || s.status === "reconnect" ? "warn" : s.status === "unreachable" ? "err" : "";
  const label =
    s.status === "connected"
      ? "Connected for you"
      : s.status === "not_connected"
        ? "Not connected for you"
        : s.status === "reconnect"
          ? "Sign-in expired"
          : s.status === "unreachable"
            ? "Unreachable"
            : s.status === "disabled"
              ? "Disabled"
              : "Checking";
  return (
    <div className="server-tile" role="button" tabIndex={0} onClick={() => navigate(`servers/${s.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`servers/${s.id}`)}>
      <div className="tile-top">
        <Logo id={s.slug} size={40} />
        <div className="tile-name">
          <strong>{s.name}</strong>
          <span className="muted small">{s.slug}</span>
        </div>
      </div>
      <div className="tile-tags">
        {s.isSystem && <span className="tag">system</span>}
        <span className="tag">{s.authMode === "oauth" ? providerName : "Shared"}</span>
      </div>
      <div className="tile-connection">
        <div className={`tile-status ${tone}`}>
          <span className={`dot ${tone}`} />
          {label}
        </div>
        {needsSignIn && s.enabled && (
          <a className="button-link primary small-btn" href={`/api/oauth/server/${s.id}/start`} onClick={(e) => e.stopPropagation()}>
            Connect
          </a>
        )}
        {connected && (
          <button className="small-btn danger" disabled={busy} onClick={disconnect}>
            Disconnect
          </button>
        )}
      </div>
      <div className="tile-foot muted small">{s.enabled ? `${s.toolCount ?? s.tools.length} tools` : "Turned off"}</div>
    </div>
  );
}
