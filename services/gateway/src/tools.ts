import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { pool } from "./db.js";
import type { Identity } from "./identity.js";
import { upstreams, type UpstreamRow } from "./upstreams.js";

// Tool naming scheme: every tool is exposed as `<server-slug>__<upstream-tool>`.
// Slugs are unique and restricted to [a-z0-9-], so two servers exposing a tool
// with the same name never collide, and the first "__" in a name always
// separates the server from the tool. Each tool also keeps its server name in
// its description, so the model knows which store or system it acts on.
export const SEP = "__";

export interface ExposedTool extends Tool {
  name: string;
  server: UpstreamRow;
  upstreamName: string;
}

// The union of tools from every enabled server, as seen by one caller.
// Unreachable servers contribute nothing but do not fail the listing.
// forChat limits the list to servers marked "Use in chat agent", because the
// chat model has a per-minute token budget and every tool definition counts.
export async function listExposedTools(opts: { forChat?: boolean } = {}): Promise<ExposedTool[]> {
  const servers = (await upstreams.loadServers()).filter((s) => s.enabled && (!opts.forChat || s.chat_enabled));
  const lists = await Promise.all(
    servers.map(async (server) => {
      const tools = await upstreams.toolsFor(server);
      return tools.map<ExposedTool>((t) => ({
        ...t,
        name: `${server.slug}${SEP}${t.name}`,
        description: `[${server.name}] ${t.description ?? ""}`.trim(),
        server,
        upstreamName: t.name,
      }));
    }),
  );
  return lists.flat();
}

export interface InvokeContext {
  user: Identity;
  source: "mcp" | "chat";
}

// Routes one call to the right upstream and writes exactly one audit row.
// Both the MCP endpoint and the chat agent go through this function, so the
// audit log and the timeouts behave the same for both.
export async function invokeTool(
  ctx: InvokeContext,
  exposedName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const idx = exposedName.indexOf(SEP);
  const slug = idx > 0 ? exposedName.slice(0, idx) : "";
  const tool = idx > 0 ? exposedName.slice(idx + SEP.length) : "";

  const { rows } = await pool.query<UpstreamRow>(
    `SELECT id, slug, name, url, auth_header, credential_enc, enabled, is_system FROM mcp_servers WHERE slug = $1`,
    [slug],
  );
  const server = rows[0];
  // Disabled or unknown servers look the same as unknown tools, so a disabled
  // server's tools cannot be called directly either.
  if (!server || !server.enabled || !tool) {
    return errorResult(`Unknown tool ${exposedName}`);
  }

  const started = Date.now();
  let outcome = "ok";
  let error: string | null = null;
  let result: CallToolResult;
  try {
    result = await upstreams.callTool(server, tool, args);
    if (result.isError) outcome = "tool_error";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outcome = /timed out/.test(msg) ? "timeout" : "unreachable";
    error = msg;
    result = errorResult(`Server ${server.name} ${outcome === "timeout" ? "timed out" : "is unreachable"}: ${msg}`);
  }
  const durationMs = Date.now() - started;

  await pool.query(
    `INSERT INTO audit_log (user_id, user_email, server_slug, tool, source, duration_ms, outcome, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.user.id, ctx.user.email, server.slug, tool, ctx.source, durationMs, outcome, error],
  );
  return result;
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
