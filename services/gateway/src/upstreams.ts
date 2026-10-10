import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
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
  auth_mode: "static" | "oauth";
}

// Who a call is made for. OAuth servers use the member's own token, so each
// member gets a separate connection to them. Static servers share one connection.
export interface Caller {
  userId: string;
  token: string; // the member's OAuth access token, for auth_mode "oauth"
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
// process talks to upstreams, so credentials stay in this module and are never
// returned to clients or to the dashboard.
export class UpstreamManager {
  private clients = new Map<string, LiveClient>();
  private tools = new Map<string, Tool[]>();
  private statuses = new Map<string, StatusEntry>();
  private inflightConnect = new Map<string, Promise<Client>>();
  private timer?: NodeJS.Timeout;

  // Background loop keeps status fresh for static servers. OAuth servers are
  // listed per member when someone asks, so they are not polled here.
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
      `SELECT id, slug, name, url, auth_header, credential_enc, enabled, is_system, chat_enabled, auth_mode
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
    for (const key of [...this.clients.keys()]) {
      if (key === id || key.startsWith(`${id}|`)) this.dropClient(key);
    }
    this.tools.delete(id);
    this.statuses.delete(id);
  }

  async refreshAll(): Promise<void> {
    const servers = await this.loadServers();
    await Promise.all(
      servers
        .filter((s) => s.auth_mode === "static")
        .map(async (s) => {
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
  // otherwise re-listed on demand. OAuth servers are always listed for the caller.
  async toolsFor(server: UpstreamRow, caller?: Caller): Promise<Tool[]> {
    if (server.auth_mode === "oauth") {
      if (!caller) return [];
      return this.listTools(server, caller);
    }
    const st = this.statuses.get(server.id);
    const fresh = st && Date.now() - st.checkedAt < config.healthIntervalMs;
    if (fresh && st.status === "connected") return this.tools.get(server.id) ?? [];
    return this.listTools(server);
  }

  // Lists the tools of one upstream. A failure marks it Unreachable and
  // returns an empty list, so one dead server never blocks the others.
  async listTools(server: UpstreamRow, caller?: Caller): Promise<Tool[]> {
    return (await this.probe(server, caller)).tools;
  }

  // Like listTools, but also reports why a server could not be listed.
  async probe(server: UpstreamRow, caller?: Caller): Promise<{ tools: Tool[]; error?: string }> {
    if (!server.enabled) return { tools: [] };
    const key = this.keyFor(server, caller);
    try {
      const client = await this.connect(server, key, config.upstreamListTimeoutMs, caller);
      const result = await withTimeout(client.listTools(), config.upstreamListTimeoutMs, "list tools");
      if (server.auth_mode === "static") {
        this.tools.set(server.id, result.tools);
        this.statuses.set(server.id, { status: "connected", checkedAt: Date.now(), toolCount: result.tools.length });
      }
      return { tools: result.tools };
    } catch (e) {
      this.dropClient(key);
      if (server.auth_mode === "static") {
        this.tools.delete(server.id);
        this.statuses.set(server.id, { status: "unreachable", error: describe(e), checkedAt: Date.now(), toolCount: 0 });
      }
      return { tools: [], error: describe(e) };
    }
  }

  // Calls one tool on one upstream with a hard timeout. Returns a CallToolResult
  // with isError set on failure, so the MCP client sees a clear message rather
  // than a protocol error.
  async callTool(server: UpstreamRow, tool: string, args: Record<string, unknown>, caller?: Caller): Promise<CallToolResult> {
    const key = this.keyFor(server, caller);
    const client = await this.connect(server, key, config.upstreamListTimeoutMs, caller);
    try {
      const result = await withTimeout(client.callTool({ name: tool, arguments: args }), config.upstreamCallTimeoutMs, `call ${tool}`);
      return result as CallToolResult;
    } catch (e) {
      // A timeout or transport error may mean the connection is broken.
      // Drop it so the next call reconnects.
      this.dropClient(key);
      if (server.auth_mode === "static") {
        this.statuses.set(server.id, { status: "unreachable", error: describe(e), checkedAt: Date.now(), toolCount: 0 });
      }
      throw e;
    }
  }

  private keyFor(server: UpstreamRow, caller?: Caller): string {
    return server.auth_mode === "oauth" && caller ? `${server.id}|${caller.userId}` : server.id;
  }

  private dropClient(key: string): void {
    const live = this.clients.get(key);
    this.clients.delete(key);
    if (live) void live.client.close().catch(() => {});
  }

  private async connect(server: UpstreamRow, key: string, timeoutMs: number, caller?: Caller): Promise<Client> {
    const headers: Record<string, string> = {};
    let secret = "";
    if (server.auth_mode === "oauth") {
      if (!caller) throw new Error("No member token for this OAuth server");
      headers.Authorization = `Bearer ${caller.token}`;
      secret = caller.token;
    } else if (server.auth_header && server.credential_enc) {
      secret = decrypt(server.credential_enc);
      headers[server.auth_header] = secret;
    }
    const fingerprint = `${server.url}|${server.auth_header ?? ""}|${createHash("sha256").update(secret).digest("hex")}`;

    const live = this.clients.get(key);
    if (live && live.fingerprint === fingerprint) return live.client;
    if (live) this.dropClient(key);

    const pendingConnect = this.inflightConnect.get(key);
    if (pendingConnect) return pendingConnect;

    const attempt = (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
      const client = new Client({ name: "kube-mcp-gateway", version: "0.1.0" });
      await withTimeout(client.connect(transport), timeoutMs, "connect");
      this.clients.set(key, { client, fingerprint });
      return client;
    })().finally(() => this.inflightConnect.delete(key));

    this.inflightConnect.set(key, attempt);
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
