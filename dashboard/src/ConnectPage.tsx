import { useEffect, useState } from "react";
import { api } from "./api";

export function ConnectPage() {
  const [origin, setOrigin] = useState(window.location.origin);
  useEffect(() => {
    api<{ publicBaseUrl: string }>("GET", "/api/gateway")
      .then((g) => g.publicBaseUrl && setOrigin(g.publicBaseUrl))
      .catch(() => undefined);
  }, []);
  const url = `${origin}/mcp`;

  return (
    <section>
      <h2>Connect an MCP client</h2>
      <p>Create an API key under <em>My API keys</em>, then add this gateway with that key. You do not need any upstream credentials.</p>
      <div className="card">
        <p className="small muted">Gateway URL</p>
        <code className="keybox">{url}</code>
      </div>
      <div className="card">
        <strong>Claude Code</strong>
        <pre>{`claude mcp add --transport http kube-mcp ${url} \\
  --header "Authorization: Bearer <your-key>"`}</pre>
      </div>
      <div className="card">
        <strong>Cursor / other clients</strong>
        <p className="small">Use Streamable HTTP with the URL above and the header <code>Authorization: Bearer &lt;your-key&gt;</code>.</p>
      </div>
      <div className="card">
        <strong>MCP Inspector</strong>
        <pre>{`npx @modelcontextprotocol/inspector`}</pre>
        <p className="small">Transport: Streamable HTTP. URL: the gateway URL. Add the Authorization header.</p>
      </div>
    </section>
  );
}
