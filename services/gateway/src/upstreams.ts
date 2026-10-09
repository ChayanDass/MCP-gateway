import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { decrypt } from "./crypto.js";
import { pool } from "./db.js";

// A registered MCP server as the gateway uses it at runtime.
export interface UpstreamRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_header: string | null;
  credential_enc: string | null;
  enabled: boolean;
  is_system: boolean;
  chat_enabled: boolean;
}

export type UpstreamStatus = "connected" | "unreachable" | "disabled" | "unknown";

interface StatusEntry {
  status: UpstreamStatus;
  error?: string;
  checkedAt: number;
  toolCount: number;
}

interface LiveClient {
  client: Client;
  fingerprint: string;
}

// Owns every connection from the gateway to an upstream. Nothing else in the
// process talks to upstreams, so upstream credentials stay in this module and
// are never returned to clients or to the dashboard.
export class UpstreamManager {
  private clients = new Map<string, LiveClient>();
  private tools = new Map<string, Tool[]>();
  private statuses = new Map<string, StatusEntry>();
  private inflightConnect = new Map<string, Promise<Client>>();
  private timer?: NodeJS.Timeout;

  // Background loop keeps status fresh so the dashboard shows Unreachable
  // without waiting for a user to trigger a call.
  start(): void {
    const tick = () => void this.refreshAll().catch((e) => console.error("health loop", e));
    tick();
    this.timer = setInterval(tick, config.healthIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const { client } of this.clients.values()) void client.close().catch(() => {});
  }

  async loadServers(): Promise<UpstreamRow[]> {
    const { rows } = await pool.query<UpstreamRow>(
      `SELECT id, slug, name, url, auth_header, credential_enc, enabled, is_system, chat_enabled
         FROM mcp_servers ORDER BY is_system DESC, name ASC`,
    );
    return rows;
  }

  status(id: string): StatusEntry {
    return this.statuses.get(id) ?? { status: "unknown", checkedAt: 0, toolCount: 0 };
  }

  // Drop the cached client and tools for a server, e.g. after an admin edits
  // its URL or credential, so the next call reconnects with the new settings.
  invalidate(id: string): void {
    const live = this.clients.get(id);
    if (live) void live.client.close().catch(() => {});
    this.clients.delete(id);
    this.tools.delete(id);
    this.statuses.delete(id);
  }

  async refreshAll(): Promise<void> {
    const servers = await this.loadServers();
    await Promise.all(
      servers.map(async (s) => {
        if (!s.enabled) {
          this.statuses.set(s.id, { status: "disabled", checkedAt: Date.now(), toolCount: 0 });
          this.tools.delete(s.id);
          return;
        }
        await this.listTools(s).catch(() => undefined);
      }),
    );
  }

  // Tools for listing, served from the health loop's cache when it is fresh,
  // otherwise re-listed on demand.
  async toolsFor(server: UpstreamRow): Promise<Tool[]> {
    const st = this.statuses.get(server.id);
    const fresh = st && Date.now() - st.checkedAt < config.healthIntervalMs;
    if (fresh && st.status === "connected") return this.tools.get(server.id) ?? [];
    return this.listTools(server);
  }

  // Lists the tools of one upstream. A failure marks it Unreachable and
  // returns an empty list, so one dead server never blocks the others.
  async listTools(server: UpstreamRow): Promise<Tool[]> {
    if (!server.enabled) return [];
    try {
      const client = await this.connect(server, config.upstreamListTimeoutMs);
      const result = await withTimeout(client.listTools(), config.upstreamListTimeoutMs, "list tools");
      this.tools.set(server.id, result.tools);
      this.statuses.set(server.id, { status: "connected", checkedAt: Date.now(), toolCount: result.tools.length });
      return result.tools;
    } catch (e) {
      this.dropClient(server.id);
      this.tools.delete(server.id);
      this.statuses.set(server.id, {
        status: "unreachable",
        error: describe(e),
        checkedAt: Date.now(),
        toolCount: 0,
      });
      return [];
    }
  }

  // Calls one tool on one upstream with a hard timeout. Returns a CallToolResult
  // with isError set on failure, so the MCP client sees a clear message rather
  // than a protocol error.
  async callTool(server: UpstreamRow, tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.connect(server, config.upstreamListTimeoutMs);
    try {
      const result = await withTimeout(
        client.callTool({ name: tool, arguments: args }),
        config.upstreamCallTimeoutMs,
        `call ${tool}`,
      );
      return result as CallToolResult;
    } catch (e) {
      // A timeout or transport error may mean the connection is broken.
      // Drop it so the next call reconnects.
      this.dropClient(server.id);
      this.statuses.set(server.id, { status: "unreachable", error: describe(e), checkedAt: Date.now(), toolCount: 0 });
      throw e;
    }
  }

  private dropClient(id: string): void {
    const live = this.clients.get(id);
    this.clients.delete(id);
    if (live) void live.client.close().catch(() => {});
  }

  private async connect(server: UpstreamRow, timeoutMs: number): Promise<Client> {
    const fingerprint = `${server.url}|${server.auth_header ?? ""}|${server.credential_enc ?? ""}`;
    const live = this.clients.get(server.id);
    if (live && live.fingerprint === fingerprint) return live.client;
    if (live) this.dropClient(server.id);

    const pending = this.inflightConnect.get(server.id);
    if (pending) return pending;

    const attempt = (async () => {
      const headers: Record<string, string> = {};
      if (server.auth_header && server.credential_enc) {
        headers[server.auth_header] = decrypt(server.credential_enc);
      }
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers },
      });
      const client = new Client({ name: "kube-mcp-gateway", version: "0.1.0" });
      await withTimeout(client.connect(transport), timeoutMs, "connect");
      this.clients.set(server.id, { client, fingerprint });
      return client;
    })().finally(() => this.inflightConnect.delete(server.id));

    this.inflightConnect.set(server.id, attempt);
    return attempt;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const upstreams = new UpstreamManager();
