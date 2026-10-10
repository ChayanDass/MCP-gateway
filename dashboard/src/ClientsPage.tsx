import { useEffect, useState } from "react";
import { api } from "./api";
import { CLIENTS, copyText, oauthSnippetFor, snippetFor, type ClientId } from "./connect";
import { Logo } from "./Logo";

type Method = "key" | "oauth";

interface KeyRow {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  revoked_at: string | null;
}

interface ClientRow {
  client_id: string;
  client_name: string;
  connected_at: string;
  expires_at: string;
}

// Clients for the logged-in member only. Pick a setup from the dropdown: a key you
// create here, or browser sign-in, which needs no key.
export function ClientsPage({ userId }: { userId: string }) {
  const [method, setMethod] = useState<Method>("oauth");
  const [client, setClient] = useState<ClientId>("claude-code");
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [connected, setConnected] = useState<ClientRow[]>([]);
  const [label, setLabel] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function load() {
    api<KeyRow[]>("GET", `/api/users/${userId}/keys`).then(setKeys).catch(() => undefined);
    api<ClientRow[]>("GET", `/api/users/${userId}/clients`).then(setConnected).catch(() => undefined);
  }
  useEffect(load, [userId]);

  async function generate() {
    setStatus(null);
    try {
      const r = await api<{ key: string }>("POST", `/api/users/${userId}/keys`, { label: label.trim() || "api key" });
      setNewKey(r.key);
      setLabel("");
      load();
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Could not create the key" });
    }
  }

  async function revoke(id: string) {
    try {
      await api("DELETE", `/api/keys/${id}`);
      load();
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Could not revoke the key" });
    }
  }

  async function disconnect(clientId: string) {
    try {
      await api("DELETE", `/api/users/${userId}/clients/${clientId}`);
      load();
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Could not disconnect" });
    }
  }

  const snippet = method === "key" ? snippetFor(client, newKey ?? "<your-key>") : oauthSnippetFor(client);
  const steps = method === "key" ? KEY_STEPS : OAUTH_STEPS;
  const activeKeys = keys.filter((k) => !k.revoked_at);

  return (
    <div className="clients-layout">
      <aside className="client-nav" aria-label="Clients">
        <div className="client-nav-title">Choose a client</div>
        {CLIENTS.map((c) => (
          <button key={c.id} className={`client-tile ${client === c.id ? "selected" : ""}`} onClick={() => setClient(c.id)}>
            <Logo id={c.id} size={38} />
            <span className="client-tile-text">
              <span className="client-tile-name">{c.label}</span>
              <span className="muted small">{CLIENT_HINT[c.id]}</span>
            </span>
          </button>
        ))}
      </aside>

      <div className="client-main">
        <div className="seg method-seg" role="tablist">
          <button role="tab" aria-selected={method === "oauth"} className={method === "oauth" ? "seg-on" : ""} onClick={() => setMethod("oauth")}>
            Browser sign-in
          </button>
          <button role="tab" aria-selected={method === "key"} className={method === "key" ? "seg-on" : ""} onClick={() => setMethod("key")}>
            API key
          </button>
        </div>

        {method === "key" && (
          <div className="card key-tools">
            <div className="field-row">
              <label className="grow">
                Key label
                <input placeholder="e.g. laptop" value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <button className="primary" onClick={generate}>
                Generate key
              </button>
            </div>
            {newKey && (
              <div className="new-key">
                <p className="small">Copy it now. It is shown once.</p>
                <code className="keybox">{newKey}</code>
              </div>
            )}
          </div>
        )}

      <div className="instructions">
        <div className="instructions-head">
          <span className="instructions-title">{method === "key" ? "Manual setup" : "Browser sign-in"}</span>
          <span className="muted small">{snippet.title}</span>
        </div>
        <ol className="steps">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <pre>{snippet.body}</pre>
        {snippet.note && <p className="small muted">{snippet.note}</p>}
        <div className="row">
          <button
            onClick={async () => {
              setCopied((await copyText(snippet.body)) ? true : false);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {status && <p className={status.kind === "ok" ? "status-line ok" : "status-line err"}>{status.text}</p>}

      <div className="card">
        <div className="card-head">
          <strong>{method === "key" ? "Your keys" : "Your connected clients"}</strong>
        </div>
        {method === "key" ? (
          activeKeys.length === 0 ? (
            <p className="muted small">You have no active keys.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Key</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {activeKeys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.label}</td>
                    <td>
                      <code>{k.prefix}…</code>
                    </td>
                    <td className="muted">{new Date(k.created_at).toLocaleDateString()}</td>
                    <td className="actions-cell">
                      <button className="small-btn danger" onClick={() => revoke(k.id)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : connected.length === 0 ? (
          <p className="muted small">No client is signed in through browser sign-in yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Connected</th>
                <th>Session ends</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {connected.map((c) => (
                <tr key={c.client_id}>
                  <td>
                    <strong>{c.client_name}</strong>
                  </td>
                  <td className="muted">{new Date(c.connected_at).toLocaleString()}</td>
                  <td className="muted">{new Date(c.expires_at).toLocaleDateString()}</td>
                  <td className="actions-cell">
                    <button className="small-btn danger" onClick={() => disconnect(c.client_id)}>
                      Disconnect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </div>
    </div>
  );
}

const CLIENT_HINT: Record<ClientId, string> = {
  "claude-code": "Terminal command",
  cursor: "mcp.json",
  vscode: ".vscode/mcp.json",
  codex: "config.toml",
  inspector: "Browser UI",
  other: "URL and header",
};

const KEY_STEPS = [
  "Enter a label and click Generate key. Copy the key shown.",
  "Paste the command or config below into your client, in place of <your-key>.",
  "Restart the client, or reload its MCP servers.",
  "Keep the key private. Revoke it here if it leaks.",
];

const OAUTH_STEPS = [
  "Paste the command or config below into your client. It has no key.",
  "Start the kube-mcp server in your client.",
  "Your browser opens the gateway sign-in page. Sign in with your team account.",
  "Click Allow once. The client gets its own token, which renews itself.",
];
