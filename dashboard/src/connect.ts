// Setup snippets for each MCP client. Every snippet uses the same gateway URL
// and the member's own key; nothing else is needed on the client side.
export type ClientId = "claude-code" | "cursor" | "vscode" | "codex" | "inspector" | "other";

export const CLIENTS: { id: ClientId; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code (GitHub Copilot / MCP)" },
  { id: "codex", label: "OpenAI Codex CLI" },
  { id: "inspector", label: "MCP Inspector (browser UI)" },
  { id: "other", label: "Any other client (URL and header)" },
];

export function gatewayUrl(): string {
  return `${window.location.origin}/mcp`;
}

export function snippetFor(client: ClientId, key: string, url = gatewayUrl()): { title: string; body: string; note?: string } {
  const auth = `Bearer ${key}`;
  switch (client) {
    case "claude-code":
      return {
        title: "Run in a terminal",
        body: `claude mcp add --transport http kube-mcp ${url} --header "Authorization: ${auth}"`,
        note: "Then start Claude Code and run /mcp to check that kube-mcp is connected.",
      };
    case "cursor":
      return {
        title: "Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project)",
        body: JSON.stringify({ mcpServers: { "kube-mcp": { url, headers: { Authorization: auth } } } }, null, 2),
        note: "Restart Cursor, or reload MCP servers in its settings.",
      };
    case "vscode":
      return {
        title: "Add to .vscode/mcp.json in your workspace",
        body: JSON.stringify({ servers: { "kube-mcp": { type: "http", url, headers: { Authorization: auth } } } }, null, 2),
        note: "In VS Code, open the MCP server list and start kube-mcp.",
      };
    case "codex":
      return {
        title: "Add to ~/.codex/config.toml",
        body: `[mcp_servers.kube-mcp]\nurl = "${url}"\nhttp_headers = { Authorization = "${auth}" }`,
      };
    case "inspector":
      return {
        title: "Run the inspector, then fill in the form",
        body: `npx @modelcontextprotocol/inspector\n\nTransport type: Streamable HTTP\nURL: ${url}\nCustom headers: Authorization = ${auth}`,
        note: "The inspector opens in your browser. Connect, then list tools.",
      };
    case "other":
      return {
        title: "Any MCP client that supports Streamable HTTP",
        body: `URL:    ${url}\nHeader: Authorization: ${auth}`,
      };
  }
}

// navigator.clipboard only works on HTTPS or localhost. This site is served over
// plain HTTP inside the cluster, so fall back to a hidden textarea.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
  return ok;
}

// Browser sign-in: the client finds the gateway's login through its metadata,
// opens the browser, and gets its own token. No key is copied by hand.
export function oauthSnippetFor(client: ClientId, url = gatewayUrl()): { title: string; body: string; note?: string } {
  switch (client) {
    case "claude-code":
      return {
        title: "Run in a terminal, then sign in from the browser",
        body: `claude mcp add --transport http kube-mcp ${url}`,
        note: "Start Claude Code, run /mcp, and choose kube-mcp to sign in.",
      };
    case "cursor":
      return {
        title: "Add to ~/.cursor/mcp.json, then sign in when prompted",
        body: JSON.stringify({ mcpServers: { "kube-mcp": { url } } }, null, 2),
      };
    case "vscode":
      return {
        title: "Add to .vscode/mcp.json, then sign in when prompted",
        body: JSON.stringify({ servers: { "kube-mcp": { type: "http", url } } }, null, 2),
      };
    case "codex":
      return {
        title: "Add to ~/.codex/config.toml, then sign in when prompted",
        body: `[mcp_servers.kube-mcp]\nurl = "${url}"`,
      };
    case "inspector":
      return {
        title: "Run the inspector and connect with browser sign-in",
        body: `npx @modelcontextprotocol/inspector\n\nTransport type: Streamable HTTP\nURL: ${url}`,
        note: "Connect, then complete the sign-in in the browser window that opens.",
      };
    case "other":
      return { title: "Any MCP client with OAuth support", body: `URL: ${url}` };
  }
}
