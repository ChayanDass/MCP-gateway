import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Logo } from "./Logo";
import { currentQuery } from "./router";

interface CatalogItem {
  key: string;
  slug: string;
  name: string;
  description: string;
  authMode: "static" | "oauth";
  provider: string | null;
  providerReady: boolean;
  installed: boolean;
  enabled: boolean;
  serverId: string | null;
  connected: boolean;
}

// The servers the gateway knows how to connect to. Admins add one with a click.
// Members connect their own accounts, so each person's tools are their own.
export function CatalogPanel({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api<CatalogItem[]>("GET", "/api/catalog").then(setItems).catch((e) => setStatus({ kind: "error", text: e.message }));
  }, []);

  useEffect(() => {
    load();
    const q = currentQuery();
    if (q.get("oauth") === "connected") setStatus({ kind: "ok", text: "Your GitHub account is connected. Its tools are now available to you." });
    if (q.get("oauth") === "failed") setStatus({ kind: "error", text: oauthReason(q.get("reason")) });
  }, [load]);

  async function install(item: CatalogItem) {
    setBusy(item.key);
    setStatus(null);
    try {
      await api("POST", `/api/catalog/${item.key}/install`);
      load();
      onChanged();
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : "Install failed" });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(item: CatalogItem) {
    setBusy(item.key);
    try {
      await api("DELETE", `/api/oauth/${item.provider}`);
      load();
      onChanged();
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : "Disconnect failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="catalog">
      <div className="section-head">
        <h3 className="section">Available MCPs</h3>
        <span className="muted small">Each member connects their own accounts. Nothing is shared.</span>
      </div>
      {status && <p className={status.kind === "ok" ? "status-line ok" : "status-line err"}>{status.text}</p>}
      <div className="catalog-grid">
        {items.map((item) => (
          <div key={item.key} className="catalog-card">
            <div className="catalog-top">
              <Logo id={item.key} size={42} />
              <div className="catalog-title">
                <strong>{item.name}</strong>
                <span className={item.authMode === "oauth" ? "badge read" : "badge"}>{item.authMode === "oauth" ? "Your account (OAuth)" : "Shared"}</span>
              </div>
            </div>
            <p className="muted small catalog-desc">{item.description}</p>
            <div className="catalog-foot">
              {!item.installed ? (
                isAdmin ? (
                  <button className="primary small-btn" onClick={() => install(item)} disabled={!!busy || !item.providerReady}>
                    {item.providerReady ? "Add to gateway" : "Not configured"}
                  </button>
                ) : (
                  <span className="muted small">Not added yet. Ask an admin.</span>
                )
              ) : item.authMode === "oauth" ? (
                item.connected ? (
                  <>
                    <span className="badge read">Connected as you</span>
                    <button className="small-btn danger" onClick={() => disconnect(item)} disabled={!!busy}>
                      Disconnect
                    </button>
                  </>
                ) : (
                  <a className="button-link primary small-btn" href={`/api/oauth/${item.provider}/start`}>
                    Connect your {item.name} account
                  </a>
                )
              ) : (
                <span className="badge">Shared server</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function oauthReason(reason: string | null): string {
  switch (reason) {
    case "denied":
      return "The connection was cancelled on GitHub.";
    case "expired":
      return "That sign-in link expired. Start the connection again.";
    case "not_installed":
      return "Add GitHub to the gateway first (an admin does this once).";
    case "exchange":
      return "GitHub did not accept the sign-in. Try again.";
    default:
      return "The connection did not complete.";
  }
}
