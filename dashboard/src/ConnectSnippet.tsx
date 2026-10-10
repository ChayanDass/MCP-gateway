import { useState } from "react";
import { CLIENTS, copyText, snippetFor, type ClientId } from "./connect";

// Client picker plus the matching setup snippet, with a copy button that works
// over plain HTTP. Pass a real key, or leave it out to show a placeholder.
export function ConnectSnippet({ apiKey }: { apiKey?: string }) {
  const [client, setClient] = useState<ClientId>("claude-code");
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const snippet = snippetFor(client, apiKey ?? "<your-key>");

  async function copy() {
    const ok = await copyText(snippet.body);
    setCopied(ok ? "ok" : "failed");
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div>
      <label>
        Which client are you setting up?
        <select value={client} onChange={(e) => setClient(e.target.value as ClientId)}>
          {CLIENTS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <p className="small muted">{snippet.title}</p>
      <pre>{snippet.body}</pre>
      {snippet.note && <p className="small muted">{snippet.note}</p>}
      <div className="row">
        <button type="button" onClick={copy}>
          {copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed, select the text" : "Copy"}
        </button>
      </div>
    </div>
  );
}
