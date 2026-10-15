import { recordToolCall } from "./metrics.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { pool } from "./db.js";
import { decrypt } from "./crypto.js";
import { accessContext, canCall, type AccessContext } from "./access.js";
import type { Identity } from "./identity.js";
import { upstreams, type Caller, type UpstreamRow } from "./upstreams.js";

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

// The member's OAuth tokens, keyed by server id. Decrypted only in memory, for
// the duration of a request.
export async function oauthTokensFor(userId: string): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ server_id: string; access_enc: string }>(
    `SELECT server_id, access_enc FROM user_oauth_tokens WHERE user_id = $1`,
    [userId],
  );
  return new Map(rows.map((r) => [r.server_id, decrypt(r.access_enc)]));
}

// The credentials to use for one server for one caller. OAuth servers need the
// member's own token; without one, the server is not available to that member.
function callerFor(server: UpstreamRow, userId: string, tokens: Map<string, string>): Caller | undefined | null {
  if (server.auth_mode !== "oauth") return undefined;
  const token = tokens.get(server.id);
  return token ? { userId, token } : null;
}

// The tools one caller may see. Tools the caller cannot use are left out, so
// they never reach the model or the client. forChat limits the list to servers
// marked "Use in chat agent", because the model has a per-minute token budget.
export async function listExposedTools(user: Identity, opts: { forChat?: boolean } = {}): Promise<ExposedTool[]> {
  const ctx = await accessContext(user);
  const tokens = await oauthTokensFor(user.id);
  const servers = (await upstreams.loadServers()).filter((s) => s.enabled && (!opts.forChat || s.chat_enabled));
  const lists = await Promise.all(
    servers.map(async (server) => {
      const caller = callerFor(server, user.id, tokens);
      if (caller === null) return []; // OAuth server the member has not connected
      const tools = await upstreams.toolsFor(server, caller);
      return tools
        .filter((t) => canCall(ctx, server.id, t))
        .map<ExposedTool>((t) => ({
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
  access?: AccessContext;
}

// Routes one call to the right upstream, enforces access, and writes exactly
// one audit row (outcome: ok, tool_error, timeout, unreachable, denied or
// not_connected). Both the MCP endpoint and the chat agent go through this.
export async function invokeTool(
  ctx: InvokeContext,
  exposedName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const idx = exposedName.indexOf(SEP);
  const slug = idx > 0 ? exposedName.slice(0, idx) : "";
  const tool = idx > 0 ? exposedName.slice(idx + SEP.length) : "";

  const { rows } = await pool.query<UpstreamRow>(
    `SELECT id, slug, name, url, auth_header, credential_enc, enabled, is_system, chat_enabled, auth_mode, provider_id
       FROM mcp_servers WHERE slug = $1`,
    [slug],
  );
  const server = rows[0];
  // Disabled or unknown servers look the same as unknown tools, so a disabled
  // server's tools cannot be called directly either.
  if (!server || !server.enabled || !tool) {
    return errorResult(`Unknown tool ${exposedName}`);
  }

  const access = ctx.access ?? (await accessContext(ctx.user));
  const tokens = await oauthTokensFor(ctx.user.id);
  const caller = callerFor(server, ctx.user.id, tokens);
  if (caller === null) {
    await audit(ctx, server.slug, tool, 0, "not_connected", "Member has not connected this account");
    return errorResult(`Connect your ${server.name} account in the dashboard (MCP servers page) to use ${exposedName}.`);
  }

  const definition = (await upstreams.toolsFor(server, caller)).find((t) => t.name === tool);
  if (!definition) return errorResult(`Unknown tool ${exposedName}`);

  if (!canCall(access, server.id, definition)) {
    await audit(ctx, server.slug, tool, 0, "denied", "Not permitted for this account");
    return errorResult(`Your account is not allowed to use ${exposedName}. Ask an admin for access.`);
  }

  const started = Date.now();
  let outcome = "ok";
  let error: string | null = null;
  let result: CallToolResult;
  try {
    result = await upstreams.callTool(server, tool, args, caller ?? undefined);
    if (result.isError) outcome = "tool_error";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outcome = /timed out/.test(msg) ? "timeout" : /401|403|Unauthorized/i.test(msg) ? "unauthorized" : "unreachable";
    error = msg;
    result = errorResult(
      outcome === "unauthorized"
        ? `${server.name} rejected your connection. Reconnect your account in the dashboard.`
        : `Server ${server.name} ${outcome === "timeout" ? "timed out" : "is unreachable"}: ${msg}`,
    );
  }
  await audit(ctx, server.slug, tool, Date.now() - started, outcome, error);
  return result;
}

async function audit(ctx: InvokeContext, slug: string, tool: string, durationMs: number, outcome: string, error: string | null) {
  recordToolCall(slug, outcome, durationMs);
  await pool.query(
    `INSERT INTO audit_log (user_id, user_email, server_slug, tool, source, duration_ms, outcome, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.user.id, ctx.user.email, slug, tool, ctx.source, durationMs, outcome, error],
  );
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
