import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { pool } from "./db.js";
import type { Identity } from "./identity.js";

// Access control. Admins can use every tool that is not blocked. Members get a
// level per server (none, read, write), and each tool can be overridden by an
// admin. The same check runs for the tool list, for calls and for the chat agent.

export type ServerAccess = "none" | "read" | "write";
export type ToolOverride = "auto" | "read" | "write" | "blocked";
export type ToolClass = "read" | "write" | "blocked";

// Read-only by name: a verb segment such as get_, list_, search_ or _read.
const READ_NAME = /(^|_)(get|list|search|read|view|fetch|count|ui_get)(_|$)/;

// The class a tool gets when no admin override is set. MCP annotations win.
// Without them, a name that reads as read-only is read, and everything else is
// write, so an unknown tool is never treated as safe.
export function classifyTool(tool: Tool): "read" | "write" {
  if (tool.annotations?.readOnlyHint === true) return "read";
  if (tool.annotations?.destructiveHint === true) return "write";
  return READ_NAME.test(tool.name) ? "read" : "write";
}

export function effectiveClass(tool: Tool, override: ToolOverride | undefined): ToolClass {
  if (override && override !== "auto") return override;
  return classifyTool(tool);
}

export interface AccessContext {
  user: Identity;
  grants: Map<string, ServerAccess>; // server id -> level, members only
  overrides: Map<string, ToolOverride>; // `${serverId}|${tool}` -> override
  systemServers: Set<string>; // server ids that are system servers (WooCommerce)
  userTools: Map<string, "allow" | "deny">; // per-member tool rules: `${serverId}|${tool}`
}

export async function accessContext(user: Identity): Promise<AccessContext> {
  const [grantRows, overrideRows, systemRows, userToolRows] = await Promise.all([
    user.role === "admin"
      ? Promise.resolve({ rows: [] as { server_id: string; access: ServerAccess }[] })
      : pool.query<{ server_id: string; access: ServerAccess }>(
          `SELECT server_id, access FROM user_server_access WHERE user_id = $1`,
          [user.id],
        ),
    pool.query<{ server_id: string; tool: string; access: ToolOverride }>(
      `SELECT server_id, tool, access FROM tool_overrides`,
    ),
    pool.query<{ id: string }>(`SELECT id FROM mcp_servers WHERE is_system`),
    pool.query<{ server_id: string; tool: string; access: "allow" | "deny" }>(
      `SELECT server_id, tool, access FROM user_tool_access WHERE user_id = $1`,
      [user.id],
    ),
  ]);
  return {
    user,
    grants: new Map(grantRows.rows.map((r) => [r.server_id, r.access])),
    overrides: new Map(overrideRows.rows.map((r) => [`${r.server_id}|${r.tool}`, r.access])),
    systemServers: new Set(systemRows.rows.map((r) => r.id)),
    userTools: new Map(userToolRows.rows.map((r) => [`${r.server_id}|${r.tool}`, r.access])),
  };
}

// System servers (WooCommerce) get none / read / read-and-write, by tool class.
// Third-party servers are all-or-nothing: an allowed member gets every tool the
// server's own token permits, so the server's permissions are the limit.
// A tool an admin blocked is never allowed, for anyone.
export function canCall(ctx: AccessContext, serverId: string, tool: Tool): boolean {
  const cls = effectiveClass(tool, ctx.overrides.get(`${serverId}|${tool.name}`));
  if (cls === "blocked") return false;
  if (ctx.user.role === "admin") return true;
  const level = ctx.grants.get(serverId) ?? "none";
  if (level === "none") return false;
  // Per-member tool rules. Deny always wins; allow grants the tool even when the
  // server level alone would not (the member still needs access to the server).
  const rule = ctx.userTools.get(`${serverId}|${tool.name}`);
  if (rule === "deny") return false;
  if (rule === "allow") return true;
  if (!ctx.systemServers.has(serverId)) return true;
  if (cls === "read") return true;
  return level === "write";
}
