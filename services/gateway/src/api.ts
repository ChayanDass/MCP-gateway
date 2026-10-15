import { takeToken } from "./ratelimit.js";
import { recordRateLimited } from "./metrics.js";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { newToken, hashPassword, sha256, verifyPassword, encrypt } from "./crypto.js";
import { PERMISSIONS, can, isKnownPermission } from "./permissions.js";
import { pool } from "./db.js";
import { handleMcpRequest } from "./mcp.js";
import { ensureConversation, runChat } from "./chat.js";
import { loadLlm, llmStep } from "./llm.js";
import { verifyGoogleCredential } from "./google.js";
import { issuer } from "./oauth-server.js";
import { exchangeCode, finishFlow, loadProvider, loadProviderById, providerReady, startFlow, type OAuthProvider } from "./oauth.js";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  identityFromBearer,
  identityFromApiKey,
  identityById,
  identityFromSession,
  sessionCookie,
  type Identity,
} from "./identity.js";
import { upstreams, type UpstreamRow } from "./upstreams.js";
import { validateUpstreamUrl } from "./ssrf.js";
import { listExposedTools, oauthTokensFor } from "./tools.js";
import { accessContext, canCall, effectiveClass, explainCall, type ToolOverride } from "./access.js";

const SLUG_RE = /^[a-z0-9-]{2,40}$/;

// Failed sign-ins per client address. After 10 failures in 15 minutes, further
// attempts are refused until the window passes.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function loginBlocked(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordFailedLogin(ip: string): void {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function isSecure(): boolean {
  return config.publicBaseUrl.startsWith("https://");
}

// Attach the current user, or reply 401/403. Returns null when the reply was sent.
async function currentUser(req: FastifyRequest, reply: FastifyReply, need?: string | string[]): Promise<Identity | null> {
  const user = await identityFromSession(req.raw);
  if (!user) {
    reply.code(401).send({ error: "Not signed in" });
    return null;
  }
  // Any one of the listed permissions is enough.
  const needed = need === undefined ? [] : Array.isArray(need) ? need : [need];
  if (needed.length && !needed.some((p) => can(user, p))) {
    reply.code(403).send({ error: "You don't have permission to do that." });
    return null;
  }
  return user;
}

export function registerApi(app: FastifyInstance): void {
  // ---- MCP endpoint: the single URL external clients use -------------------
  app.all("/mcp", async (req, reply) => {
    const user = await identityFromBearer(req.headers.authorization);
    if (user && !can(user, "mcp.use")) return reply.code(403).send({ error: "Your role can't connect MCP clients." });
    if (user) {
      const limit = takeToken(user.id, config.rateLimitPerMinute);
      if (!limit.ok) {
        recordRateLimited("mcp");
        return reply.code(429).header("Retry-After", String(limit.retryAfter)).send({ error: "Too many requests. Try again shortly." });
      }
    }
    if (!user) {
      // The MCP authorization spec: point the client at the metadata so it can log in.
      return reply
        .code(401)
        .header("WWW-Authenticate", `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource"`)
        .send({ error: "Sign in to the gateway, or send a valid API key" });
    }
    reply.hijack();
    await handleMcpRequest(user, req.raw, reply.raw, req.body);
  });

  // ---- Auth -----------------------------------------------------------------
  app.post<{ Body: { email?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
    if (loginBlocked(req.ip)) {
      return reply.code(429).send({ error: "Too many sign-in attempts. Try again in a few minutes." });
    }
    const { email = "", password = "" } = req.body ?? {};
    const { rows } = await pool.query<{ id: string; password_hash: string | null; disabled: boolean }>(
      `SELECT id, password_hash, disabled FROM users WHERE email = $1`,
      [email.trim().toLowerCase()],
    );
    const u = rows[0];
    const ok = u && u.password_hash && !u.disabled && (await verifyPassword(password, u.password_hash));
    if (!ok) {
      recordFailedLogin(req.ip);
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    loginAttempts.delete(req.ip);
    const token = await createSession(u.id);
    reply.header("Set-Cookie", sessionCookie(token, isSecure()));
    return identityById(u.id);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await deleteSession(req.raw);
    reply.header("Set-Cookie", clearSessionCookie(isSecure()));
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const user = await currentUser(req, reply);
    return user ?? undefined;
  });

  app.get("/api/gateway", async () => ({
    mcpPath: "/mcp",
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
    googleClientId: config.googleClientId,
  }));

  // Google sign-in. The browser sends the ID token from Google Identity Services.
  // Only existing, enabled gateway users can sign in this way: Google never
  // creates an account here, so admins still decide who has access.
  app.post<{ Body: { credential?: string } }>("/api/auth/google", async (req, reply) => {
    if (loginBlocked(req.ip)) {
      return reply.code(429).send({ error: "Too many sign-in attempts. Try again in a few minutes." });
    }
    const credential = req.body?.credential ?? "";
    if (!credential) return reply.code(400).send({ error: "Missing Google credential" });
    let profile: { email: string; name: string };
    try {
      profile = await verifyGoogleCredential(credential);
    } catch (e) {
      recordFailedLogin(req.ip);
      return reply.code(401).send({ error: e instanceof Error ? e.message : "Google sign-in failed" });
    }
    const { rows } = await pool.query<{ id: string; disabled: boolean }>(
      `SELECT id, disabled FROM users WHERE email = $1`,
      [profile.email],
    );
    const u = rows[0];
    if (!u || u.disabled) {
      recordFailedLogin(req.ip);
      return reply.code(403).send({ error: `No gateway account for ${profile.email}. Ask an admin to add you.` });
    }
    loginAttempts.delete(req.ip);
    const token = await createSession(u.id);
    reply.header("Set-Cookie", sessionCookie(token, isSecure()));
    return identityById(u.id);
  });

  // ---- MCP servers ----------------------------------------------------------
  app.get("/api/servers", async (req, reply) => {
    const viewer = await currentUser(req, reply);
    if (!viewer) return;
    const servers = await upstreams.loadServers();
    const overrides = await loadOverrides();
    const myTokens = await oauthTokensFor(viewer.id);
    // Each viewer sees only the tools they may call. Admins see all of them.
    const viewerCtx = await accessContext(viewer);
    const views = await Promise.all(
      servers.map(async (s) => {
        // OAuth servers have no shared status: each viewer sees their own connection.
        if (s.auth_mode === "oauth") {
          const token = myTokens.get(s.id);
          if (!s.enabled) return serverView(s, [], "disabled", null, 0, overrides);
          if (!token) return serverView(s, [], "not_connected", null, 0, overrides);
          const probe = await upstreams.probe(s, { userId: viewer.id, token });
          if (probe.error) {
            const reconnect = /401|403|Unauthorized/i.test(probe.error);
            return serverView(s, [], reconnect ? "reconnect" : "unreachable", probe.error, 0, overrides);
          }
          const mine = probe.tools.filter((t) => canCall(viewerCtx, s.id, t as never));
          return serverView(s, mine, "connected", null, mine.length, overrides);
        }
        const tools = s.enabled ? (await upstreams.toolsFor(s)).filter((t) => canCall(viewerCtx, s.id, t as never)) : [];
        const st = upstreams.status(s.id);
        return {
          id: s.id,
          slug: s.slug,
          name: s.name,
          url: s.url,
          enabled: s.enabled,
          chatEnabled: s.chat_enabled,
          isSystem: s.is_system,
          authMode: s.auth_mode,
          providerId: s.provider_id,
          hasCredential: Boolean(s.credential_enc),
          authHeader: s.auth_header,
          status: s.enabled ? st.status : "disabled",
          error: st.error ?? null,
          checkedAt: st.checkedAt,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            class: effectiveClass(t, overrides.get(`${s.id}|${t.name}`)),
            override: overrides.get(`${s.id}|${t.name}`) ?? "auto",
          })),
        };
      }),
    );
    return views;
  });

  app.post<{ Body: ServerInput }>("/api/servers", async (req, reply) => {
    if (!(await currentUser(req, reply, "servers.manage"))) return;
    const input = req.body ?? ({} as ServerInput);
    const problem = await validateServerInput(input, true);
    if (problem) return reply.code(400).send({ error: problem });
    if (input.authMode === "oauth") {
      if (!input.providerId) return reply.code(400).send({ error: "Choose a sign-in provider" });
      const { rows } = await pool.query(`SELECT 1 FROM oauth_providers WHERE id = $1`, [input.providerId]);
      if (!rows[0]) return reply.code(400).send({ error: "That sign-in provider does not exist" });
    }
    const oauth = input.authMode === "oauth";
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO mcp_servers (slug, name, url, auth_header, credential_enc, enabled, chat_enabled, auth_mode, provider_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        input.slug,
        input.name,
        validateUpstreamUrl(input.url!),
        oauth ? null : input.authHeader || null,
        !oauth && input.credential ? encrypt(input.credential) : null,
        input.enabled ?? true,
        input.chatEnabled ?? false,
        oauth ? "oauth" : "static",
        oauth ? input.providerId : null,
      ],
    );
    void upstreams.refreshAll();
    return reply.code(201).send({ id: rows[0].id });
  });

  app.patch<{ Params: { id: string }; Body: ServerInput }>("/api/servers/:id", async (req, reply) => {
    if (!(await currentUser(req, reply, "servers.manage"))) return;
    const input = req.body ?? ({} as ServerInput);
    const problem = await validateServerInput(input, false);
    if (problem) return reply.code(400).send({ error: problem });
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (input.name !== undefined) set("name", input.name);
    if (input.url !== undefined) set("url", validateUpstreamUrl(input.url));
    if (input.enabled !== undefined) set("enabled", input.enabled);
    if (input.chatEnabled !== undefined) set("chat_enabled", input.chatEnabled);
    if (input.authHeader !== undefined) set("auth_header", input.authHeader || null);
    if (input.credential !== undefined) set("credential_enc", input.credential ? encrypt(input.credential) : null);
    if (sets.length === 0) return reply.code(400).send({ error: "Nothing to update" });
    vals.push(req.params.id);
    const { rowCount } = await pool.query(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    if (!rowCount) return reply.code(404).send({ error: "Server not found" });
    upstreams.invalidate(req.params.id);
    void upstreams.refreshAll();
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/servers/:id", async (req, reply) => {
    if (!(await currentUser(req, reply, "servers.manage"))) return;
    const { rowCount } = await pool.query(`DELETE FROM mcp_servers WHERE id = $1`, [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: "Server not found" });
    upstreams.invalidate(req.params.id);
    return { ok: true };
  });

  // Per-tool override: auto (classified by annotations or name), read, write or blocked.
  app.put<{ Params: { id: string }; Body: { tool?: string; access?: string } }>("/api/servers/:id/tools", async (req, reply) => {
    if (!(await currentUser(req, reply, "tools.manage"))) return;
    const { tool = "", access = "auto" } = req.body ?? {};
    if (!tool) return reply.code(400).send({ error: "Tool name is required" });
    if (!["auto", "read", "write", "blocked"].includes(access)) return reply.code(400).send({ error: "Access must be auto, read, write or blocked" });
    if (access === "auto") {
      await pool.query(`DELETE FROM tool_overrides WHERE server_id = $1 AND tool = $2`, [req.params.id, tool]);
    } else {
      await pool.query(
        `INSERT INTO tool_overrides (server_id, tool, access) VALUES ($1, $2, $3)
         ON CONFLICT (server_id, tool) DO UPDATE SET access = $3`,
        [req.params.id, tool, access],
      );
    }
    return { ok: true };
  });

  // ---- Users and API keys ---------------------------------------------------
  app.get("/api/users", async (req, reply) => {
    if (!(await currentUser(req, reply, ["members.manage", "tools.manage"]))) return;
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, r.name AS role, r.id AS role_id, u.disabled, u.created_at,
              count(k.id) FILTER (WHERE k.revoked_at IS NULL) AS active_keys
         FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN api_keys k ON k.user_id = u.id
        GROUP BY u.id, r.id, r.name ORDER BY u.created_at`,
    );
    return rows;
  });

  // Access per server for one user: none, read or write. Admins always have full access.
  app.get<{ Params: { id: string } }>("/api/users/:id/access", async (req, reply) => {
    if (!(await currentUser(req, reply, "members.manage"))) return;
    const { rows } = await pool.query(
      `SELECT s.id AS server_id, s.slug, s.name, s.is_system, COALESCE(a.access, 'none') AS access
         FROM mcp_servers s LEFT JOIN user_server_access a ON a.server_id = s.id AND a.user_id = $1
        ORDER BY s.is_system DESC, s.name`,
      [req.params.id],
    );
    return rows;
  });

  app.put<{ Params: { id: string }; Body: { serverId?: string; access?: string } }>("/api/users/:id/access", async (req, reply) => {
    const admin = await currentUser(req, reply, "members.manage");
    if (!admin) return;
    const { serverId = "", access = "none" } = req.body ?? {};
    if (!["none", "read", "write"].includes(access)) return reply.code(400).send({ error: "Access must be none, read or write" });
    if (access === "none") {
      await pool.query(`DELETE FROM user_server_access WHERE user_id = $1 AND server_id = $2`, [req.params.id, serverId]);
    } else {
      await pool.query(
        `INSERT INTO user_server_access (user_id, server_id, access) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, server_id) DO UPDATE SET access = $3`,
        [req.params.id, serverId, access],
      );
    }
    return { ok: true };
  });

  // Create a member (or admin) with a name, role, password and per-server access.
  app.post<{ Body: { email?: string; name?: string; roleId?: string; password?: string; access?: Record<string, string> } }>("/api/users", async (req, reply) => {
    if (!(await currentUser(req, reply, "members.manage"))) return;
    const { email = "", name = "", roleId = "", password = "", access = {} } = req.body ?? {};
    if (!email.includes("@") || !name.trim()) return reply.code(400).send({ error: "Email and name are required" });
    if (password.length < 8) return reply.code(400).send({ error: "Password must be at least 8 characters" });
    const { rows: roleRows } = await pool.query(`SELECT id FROM roles WHERE id = $1`, [roleId || null]).catch(() => ({ rows: [] as { id: string }[] }));
    if (!roleRows[0]) return reply.code(400).send({ error: "Choose a role for this member" });
    for (const level of Object.values(access)) {
      if (!["none", "read", "write"].includes(level)) return reply.code(400).send({ error: "Access must be none, read or write" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, name, role_id, password_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [email.trim().toLowerCase(), name.trim(), roleId, await hashPassword(password)],
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "A user with that email already exists" });
      }
      for (const [serverId, level] of Object.entries(access)) {
        if (level === "none") continue;
        await client.query(`INSERT INTO user_server_access (user_id, server_id, access) VALUES ($1, $2, $3)`, [rows[0].id, serverId, level]);
      }
      await client.query("COMMIT");
      return reply.code(201).send({ id: rows[0].id });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });

  // Edit a user: name, role, disabled. Keeps at least one active admin.
  app.patch<{ Params: { id: string }; Body: { name?: string; disabled?: boolean; roleId?: string } }>("/api/users/:id", async (req, reply) => {
    const admin = await currentUser(req, reply, "members.manage");
    if (!admin) return;
    const { name, disabled, roleId } = req.body ?? {};
    if (name !== undefined && !name.trim()) return reply.code(400).send({ error: "Name cannot be empty" });
    const { rows: cur } = await pool.query<{ role_id: string; permissions: string[] }>(
      `SELECT u.role_id, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [req.params.id],
    );
    if (!cur[0]) return reply.code(404).send({ error: "Member not found" });
    if (req.params.id === admin.id && (disabled === true || (roleId !== undefined && roleId !== cur[0].role_id))) {
      return reply.code(400).send({ error: "You cannot disable yourself or change your own role" });
    }
    let nextPerms = cur[0].permissions;
    if (roleId !== undefined && roleId !== cur[0].role_id) {
      const { rows: r } = await pool.query<{ permissions: string[] }>(`SELECT permissions FROM roles WHERE id = $1`, [roleId]).catch(() => ({ rows: [] as { permissions: string[] }[] }));
      if (!r[0]) return reply.code(400).send({ error: "That role doesn't exist" });
      nextPerms = r[0].permissions;
    }
    const losesRoleManager = (cur[0].permissions.includes("roles.manage") && !nextPerms.includes("roles.manage")) || disabled === true;
    if (losesRoleManager && !(await otherActiveRoleManager(req.params.id))) {
      return reply.code(400).send({ error: "At least one active member who can manage roles must remain" });
    }
    await pool.query(
      `UPDATE users SET name = COALESCE($2, name), disabled = COALESCE($3, disabled), role_id = COALESCE($4, role_id) WHERE id = $1`,
      [req.params.id, name?.trim() ?? null, disabled ?? null, roleId ?? null],
    );
    // Revoking access ends their sessions at once. Their keys stop working on the next call.
    if (disabled === true) await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [req.params.id]);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { password?: string } }>("/api/users/:id/password", async (req, reply) => {
    if (!(await currentUser(req, reply, "members.manage"))) return;
    const password = req.body?.password ?? "";
    if (password.length < 8) return reply.code(400).send({ error: "Password must be at least 8 characters" });
    const { rowCount } = await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [req.params.id, await hashPassword(password)]);
    if (!rowCount) return reply.code(404).send({ error: "User not found" });
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [req.params.id]);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
    const admin = await currentUser(req, reply, "members.manage");
    if (!admin) return;
    if (req.params.id === admin.id) return reply.code(400).send({ error: "You cannot delete yourself" });
    const { rows } = await pool.query<{ permissions: string[] }>(`SELECT r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: "Member not found" });
    if (rows[0].permissions.includes("roles.manage") && !(await otherActiveRoleManager(req.params.id))) {
      return reply.code(400).send({ error: "At least one active member who can manage roles must remain" });
    }
    await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });

  // A member's keys and connected clients, for the Members page. Admins see anyone;
  // members see only themselves.

  app.get<{ Params: { id: string } }>("/api/users/:id/clients", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    if (user.id !== req.params.id && !can(user, "members.manage")) return reply.code(403).send({ error: "Not allowed" });
    // A client counts as connected while it holds an unrevoked, unexpired refresh token.
    const { rows } = await pool.query(
      `SELECT c.client_id, c.client_name, min(t.created_at) AS connected_at, max(t.expires_at) AS expires_at
         FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.user_id = $1 AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.expires_at > now()
        GROUP BY c.client_id, c.client_name
        ORDER BY connected_at DESC`,
      [req.params.id],
    );
    return rows;
  });

  // Disconnect a client: revokes all of that member's tokens for that client.
  app.delete<{ Params: { id: string; clientId: string } }>("/api/users/:id/clients/:clientId", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    if (user.id !== req.params.id && !can(user, "members.manage")) return reply.code(403).send({ error: "Not allowed" });
    await pool.query(
      `UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`,
      [req.params.id, req.params.clientId],
    );
    return { ok: true };
  });

  app.get("/api/keys", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT id, label, prefix, created_at, revoked_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [user.id],
    );
    return rows;
  });

  // Admins can issue keys for anyone; members only for themselves.

  // A member revokes their own key. Admins don't revoke member keys.
  app.delete<{ Params: { id: string } }>("/api/keys/:id", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    const { rowCount } = await pool.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND user_id = $2`, [req.params.id, user.id]);
    if (!rowCount) return reply.code(404).send({ error: "Key not found" });
    return { ok: true };
  });

  // A member creates their own key for an MCP client. Shown once; only the hash is stored.
  app.post<{ Body: { label?: string } }>("/api/keys", async (req, reply) => {
    const user = await currentUser(req, reply, "mcp.use");
    if (!user) return;
    const label = (req.body?.label ?? "").trim() || "API key";
    const token = newToken("kmcp_");
    await pool.query(`INSERT INTO api_keys (user_id, label, prefix, key_hash) VALUES ($1, $2, $3, $4)`, [user.id, label, token.slice(0, 13), sha256(token)]);
    return reply.code(201).send({ key: token, label });
  });

  // ---- Audit ----------------------------------------------------------------
  app.get<{ Querystring: { limit?: string } }>("/api/audit", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const { rows } = await pool.query(
      `SELECT id, ts, user_email, server_slug, tool, source, duration_ms, outcome, error
         FROM audit_log WHERE ($1 OR user_id = $2)
        ORDER BY ts DESC LIMIT $3`,
      [can(user, "audit.view_all"), user.id, limit],
    );
    return rows;
  });

  // ---- Model settings (admin) -----------------------------------------------
  // The API key is write-only: it is encrypted on save and never returned.
  app.get("/api/llm", async (req, reply) => {
    if (!(await currentUser(req, reply, "model.manage"))) return;
    const cfg = await loadLlm();
    const { rows } = await pool.query<{ catalog: string[]; catalog_at: string | null }>(
      `SELECT catalog, catalog_at FROM llm_settings WHERE id = 1`,
    );
    const catalog = rows[0]?.catalog ?? [];
    const catalogAt = rows[0]?.catalog_at ?? null;
    return cfg
      ? { configured: true, provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, hasKey: Boolean(cfg.apiKey), catalog, catalogAt }
      : { configured: false, provider: "openai", baseUrl: "", model: "", hasKey: false, catalog, catalogAt };
  });

  app.put<{ Body: { provider?: string; baseUrl?: string; model?: string; apiKey?: string } }>("/api/llm", async (req, reply) => {
    if (!(await currentUser(req, reply, "model.manage"))) return;
    const { provider, baseUrl = "", model = "", apiKey } = req.body ?? {};
    if (provider !== "openai" && provider !== "anthropic") return reply.code(400).send({ error: "Provider must be openai or anthropic" });
    if (!model.trim()) return reply.code(400).send({ error: "Model name is required" });
    let url: string;
    try {
      url = validateUpstreamUrl(baseUrl.trim(), { allowLoopback: true });
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Invalid base URL" });
    }
    // undefined: keep the stored key. "": clear it. Any other value: replace it.
    const existing = await loadLlm();
    const keyEnc =
      apiKey === undefined ? (existing?.apiKey ? encrypt(existing.apiKey) : null) : apiKey ? encrypt(apiKey.trim()) : null;
    await pool.query(
      `INSERT INTO llm_settings (id, provider, base_url, model, api_key_enc, updated_at)
       VALUES (1, $1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET provider = $1, base_url = $2, model = $3, api_key_enc = $4, updated_at = now()`,
      [provider, url.replace(/\/$/, ""), model.trim(), keyEnc],
    );
    return { ok: true };
  });

  // Lists the models the saved provider and key can use, so the admin can pick
  // a valid name instead of guessing one.
  app.get("/api/llm/models", async (req, reply) => {
    if (!(await currentUser(req, reply, "model.manage"))) return;
    const cfg = await loadLlm();
    if (!cfg) return reply.code(400).send({ error: "Save a provider first" });
    const base = cfg.baseUrl.replace(/\/$/, "");
    const url = cfg.provider === "anthropic" ? `${base}/v1/models` : `${base}/models`;
    const headers: Record<string, string> =
      cfg.provider === "anthropic"
        ? { "x-api-key": cfg.apiKey ?? "", "anthropic-version": "2023-06-01" }
        : cfg.apiKey
          ? { Authorization: `Bearer ${cfg.apiKey}` }
          : {};
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      const text = await res.text();
      if (!res.ok) return reply.code(502).send({ error: `Provider returned ${res.status}: ${text.slice(0, 200)}` });
      const data = JSON.parse(text) as { data?: { id: string }[] };
      const ids = (data.data ?? []).map((m) => m.id).sort();
      await pool.query(`UPDATE llm_settings SET catalog = $1::jsonb, catalog_at = now() WHERE id = 1`, [JSON.stringify(ids)]);
      return { models: ids };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Could not list models" });
    }
  });

  // Sends one short prompt with no tools, to confirm the provider, key and model work.
  app.post("/api/llm/test", async (req, reply) => {
    if (!(await currentUser(req, reply, "model.manage"))) return;
    const cfg = await loadLlm();
    if (!cfg) return reply.code(400).send({ error: "Save a model first" });
    try {
      const res = await llmStep(cfg, "Reply in one short sentence.", [{ role: "user", content: "Say hello and name yourself." }], []);
      return { ok: true, reply: res.text };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Test failed" });
    }
  });

  // ---- Overview -------------------------------------------------------------
  // Live numbers for the home page. Members see their own activity; admins see
  // everything and the team totals.
  app.get("/api/overview", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    const seeAll = can(user, "audit.view_all");
    const seeMembers = can(user, "members.manage");
    const [servers, calls, recent, members, model] = await Promise.all([
      pool.query<{ total: string; enabled: string; system: string }>(
        `SELECT count(*) AS total, count(*) FILTER (WHERE enabled) AS enabled, count(*) FILTER (WHERE is_system) AS system FROM mcp_servers`,
      ),
      pool.query<{ total: string; errors: string; denied: string }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE outcome NOT IN ('ok')) AS errors,
                count(*) FILTER (WHERE outcome = 'denied') AS denied
           FROM audit_log WHERE ts > now() - interval '24 hours' AND ($1 OR user_id = $2)`,
        [seeAll, user.id],
      ),
      pool.query(
        `SELECT ts, user_email, server_slug, tool, source, outcome, duration_ms
           FROM audit_log WHERE ($1 OR user_id = $2) ORDER BY ts DESC LIMIT 6`,
        [seeAll, user.id],
      ),
      seeMembers
        ? pool.query<{ total: string; admins: string }>(`SELECT count(*) AS total, count(*) FILTER (WHERE 'roles.manage' = ANY(r.permissions)) AS admins FROM users u JOIN roles r ON r.id = u.role_id WHERE NOT u.disabled`)
        : Promise.resolve({ rows: [] as { total: string; admins: string }[] }),
      loadLlm(),
    ]);
    const exposed = await listExposedTools(user);
    // A server counts as connected when it answers for this viewer: shared servers
    // by the health check, OAuth servers by the viewer's own token.
    const myTokens = await oauthTokensFor(user.id);
    const enabledServers = (await upstreams.loadServers()).filter((s) => s.enabled);
    const connected = await Promise.all(
      enabledServers.map(async (s) => {
        if (s.auth_mode !== "oauth") return upstreams.status(s.id).status;
        const token = myTokens.get(s.id);
        if (!token) return "not_connected";
        const probe = await upstreams.probe(s, { userId: user.id, token });
        return probe.error ? "unreachable" : "connected";
      }),
    );
    return {
      servers: {
        total: Number(servers.rows[0].total),
        enabled: enabledServers.length,
        connected: connected.filter((x) => x === "connected").length,
        system: Number(servers.rows[0].system),
      },
      tools: exposed.length,
      calls24h: Number(calls.rows[0].total),
      errors24h: Number(calls.rows[0].errors),
      denied24h: Number(calls.rows[0].denied),
      members: members.rows[0] ? { active: Number(members.rows[0].total), admins: Number(members.rows[0].admins) } : null,
      model: model ? { model: model.model, provider: model.provider, baseUrl: model.baseUrl } : null,
      recent: recent.rows,
    };
  });

  // ---- Permissions and roles ----------------------------------------------------
  // The list of permissions, so the dashboard can show them without a hard-coded copy.
  app.get("/api/permissions", async (req, reply) => {
    if (!(await currentUser(req, reply))) return;
    return PERMISSIONS;
  });

  app.get("/api/roles", async (req, reply) => {
    if (!(await currentUser(req, reply, ["roles.manage", "members.manage"]))) return;
    const { rows } = await pool.query(
      `SELECT r.id, r.name, r.description, r.permissions, r.builtin, count(u.id) AS user_count
         FROM roles r LEFT JOIN users u ON u.role_id = r.id
        GROUP BY r.id ORDER BY r.builtin DESC, r.name`,
    );
    return rows.map((r) => ({ ...r, user_count: Number(r.user_count) }));
  });

  // Checks a role's name and permissions. Returns an error message, or null if they're fine.
  const roleProblem = (name: string, permissions: unknown): string | null => {
    if (!name.trim() || name.trim().length > 60) return "A role needs a name of up to 60 characters";
    if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string" || !isKnownPermission(p))) return "Unknown permission in this role";
    return null;
  };

  app.post<{ Body: { name?: string; description?: string; permissions?: string[] } }>("/api/roles", async (req, reply) => {
    if (!(await currentUser(req, reply, "roles.manage"))) return;
    const name = req.body?.name ?? "";
    const permissions = req.body?.permissions ?? [];
    const problem = roleProblem(name, permissions);
    if (problem) return reply.code(400).send({ error: problem });
    try {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO roles (name, description, permissions) VALUES ($1, $2, $3) RETURNING id`,
        [name.trim(), (req.body?.description ?? "").trim(), [...new Set(permissions)]],
      );
      return reply.code(201).send({ id: rows[0].id });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return reply.code(409).send({ error: "A role with that name already exists" });
      throw e;
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; description?: string; permissions?: string[] } }>("/api/roles/:id", async (req, reply) => {
    if (!(await currentUser(req, reply, "roles.manage"))) return;
    const { rows: cur } = await pool.query<{ name: string; builtin: boolean }>(`SELECT name, builtin FROM roles WHERE id = $1`, [req.params.id]);
    if (!cur[0]) return reply.code(404).send({ error: "Role not found" });
    if (cur[0].builtin && cur[0].name === "Admin") return reply.code(400).send({ error: "The Admin role always has every permission and can't be changed" });
    const name = req.body?.name ?? cur[0].name;
    const permissions = req.body?.permissions;
    const problem = roleProblem(name, permissions ?? []);
    if (problem && (req.body?.name !== undefined || permissions !== undefined)) return reply.code(400).send({ error: problem });
    try {
      await pool.query(
        `UPDATE roles SET name = $2, description = COALESCE($3, description), permissions = COALESCE($4, permissions) WHERE id = $1`,
        [req.params.id, name.trim(), req.body?.description?.trim() ?? null, permissions ? [...new Set(permissions)] : null],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return reply.code(409).send({ error: "A role with that name already exists" });
      throw e;
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/roles/:id", async (req, reply) => {
    if (!(await currentUser(req, reply, "roles.manage"))) return;
    const { rows } = await pool.query<{ builtin: boolean; users: string }>(
      `SELECT r.builtin, count(u.id) AS users FROM roles r LEFT JOIN users u ON u.role_id = r.id WHERE r.id = $1 GROUP BY r.id`,
      [req.params.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: "Role not found" });
    if (rows[0].builtin) return reply.code(400).send({ error: "Built-in roles can't be deleted" });
    if (Number(rows[0].users) > 0) return reply.code(400).send({ error: "Move its members to another role first" });
    await pool.query(`DELETE FROM roles WHERE id = $1`, [req.params.id]);
    return { ok: true };
  });

  // ---- OAuth providers (admin): any sign-in service, configured in the dashboard ----
  const providerView = (p: OAuthProvider & { created_at?: string }) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    authorizeUrl: p.authorize_url,
    tokenUrl: p.token_url,
    scopes: p.scopes,
    scopeParam: p.scope_param,
    pkce: p.pkce,
    tokenPath: p.token_path,
    clientId: p.client_id,
    hasSecret: Boolean(p.client_secret_enc),
    redirectUri: `${config.publicBaseUrl.replace(/\/$/, "")}/api/oauth/${p.slug}/callback`,
  });

  app.get("/api/oauth-providers", async (req, reply) => {
    if (!(await currentUser(req, reply, "providers.manage"))) return;
    const { rows } = await pool.query<OAuthProvider>(`SELECT * FROM oauth_providers ORDER BY name`);
    return rows.map(providerView);
  });

  app.post<{ Body: Record<string, string | boolean | undefined> }>("/api/oauth-providers", async (req, reply) => {
    if (!(await currentUser(req, reply, "providers.manage"))) return;
    const v = validateProviderInput(req.body ?? {}, true);
    if (typeof v === "string") return reply.code(400).send({ error: v });
    try {
      await pool.query(
        `INSERT INTO oauth_providers (slug, name, authorize_url, token_url, scopes, scope_param, pkce, token_path, client_id, client_secret_enc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [v.slug, v.name, v.authorizeUrl, v.tokenUrl, v.scopes, v.scopeParam, v.pkce, v.tokenPath, v.clientId, encrypt(v.clientSecret)],
      );
    } catch (e) {
      if (String(e).includes("duplicate key")) return reply.code(409).send({ error: "A provider with that slug already exists" });
      throw e;
    }
    return reply.code(201).send({ ok: true });
  });

  app.put<{ Params: { slug: string }; Body: Record<string, string | boolean | undefined> }>("/api/oauth-providers/:slug", async (req, reply) => {
    if (!(await currentUser(req, reply, "providers.manage"))) return;
    const existing = await loadProvider(req.params.slug);
    if (!existing) return reply.code(404).send({ error: "Provider not found" });
    const v = validateProviderInput({ ...req.body, slug: existing.slug }, false);
    if (typeof v === "string") return reply.code(400).send({ error: v });
    await pool.query(
      `UPDATE oauth_providers SET name = $2, authorize_url = $3, token_url = $4, scopes = $5, scope_param = $6, pkce = $7, token_path = $8, client_id = $9,
              client_secret_enc = COALESCE($10, client_secret_enc) WHERE slug = $1`,
      [existing.slug, v.name, v.authorizeUrl, v.tokenUrl, v.scopes, v.scopeParam, v.pkce, v.tokenPath, v.clientId, v.clientSecret ? encrypt(v.clientSecret) : null],
    );
    return { ok: true };
  });

  app.delete<{ Params: { slug: string } }>("/api/oauth-providers/:slug", async (req, reply) => {
    if (!(await currentUser(req, reply, "providers.manage"))) return;
    const { rowCount } = await pool.query(`DELETE FROM oauth_providers WHERE slug = $1`, [req.params.slug]);
    if (!rowCount) return reply.code(404).send({ error: "Provider not found" });
    return { ok: true };
  });

  // ---- Per-member OAuth connections to an MCP server ------------------------------
  // Start: the member clicks Connect on a server that uses a provider.
  app.get<{ Params: { id: string } }>("/api/oauth/server/:id/start", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query<{ provider_id: string | null; auth_mode: string; enabled: boolean }>(
      `SELECT provider_id, auth_mode, enabled FROM mcp_servers WHERE id = $1`,
      [req.params.id],
    );
    const server = rows[0];
    if (!server || server.auth_mode !== "oauth" || !server.provider_id || !server.enabled) {
      return reply.code(400).send({ error: "This server does not use browser sign-in" });
    }
    const provider = await loadProviderById(server.provider_id);
    if (!provider || !providerReady(provider)) return reply.code(400).send({ error: `${provider?.name ?? "This provider"} is not configured yet` });
    return reply.redirect(startFlow(provider, user.id, req.params.id));
  });

  // Callback: the provider sends the member back with a code. The state was issued
  // to this member for this server, and can be used once.
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/oauth/:provider/callback",
    async (req, reply) => {
      const back = (q: string) => reply.redirect(`/#/servers?${q}`);
      if (req.query.error) return back("oauth=failed&reason=denied");
      const flow = req.query.state ? finishFlow(req.params.provider, req.query.state) : null;
      if (!flow || !req.query.code) return back("oauth=failed&reason=expired");
      const provider = await loadProvider(req.params.provider);
      if (!provider) return back("oauth=failed&reason=unknown_provider");
      try {
        const token = await exchangeCode(provider, req.query.code, flow.verifier);
        await pool.query(
          `INSERT INTO user_oauth_tokens (user_id, server_id, access_enc, scope, connected_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (user_id, server_id) DO UPDATE SET access_enc = $3, scope = $4, connected_at = now()`,
          [flow.userId, flow.serverId, encrypt(token.accessToken), token.scope],
        );
        return back(`oauth=connected&server=${flow.serverId}`);
      } catch (e) {
        req.log.warn({ err: e instanceof Error ? e.message : e, provider: provider.slug }, "oauth exchange failed");
        return back("oauth=failed&reason=exchange");
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/oauth/server/:id", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    await pool.query(`DELETE FROM user_oauth_tokens WHERE user_id = $1 AND server_id = $2`, [user.id, req.params.id]);
    return { ok: true };
  });

  // ---- Per-member tool permissions ----------------------------------------------
  // For each enabled server: its tools, and this member's rule for each (inherit,
  // allow or deny) with the result. Static servers list live; OAuth servers use the
  // tool names recorded the last time someone connected to them.
  app.get<{ Params: { id: string } }>("/api/users/:id/tool-access", async (req, reply) => {
    if (!(await currentUser(req, reply, "tools.manage"))) return;
    const target = await identityById(req.params.id);
    if (!target) return reply.code(404).send({ error: "User not found" });
    const ctx = await accessContext(target);
    const servers = (await upstreams.loadServers()).filter((s) => s.enabled);
    const overrides = await loadOverrides();
    const out = [];
    for (const s of servers) {
      let tools: { name: string; description?: string; annotations?: unknown }[];
      if (s.auth_mode === "oauth") {
        const { rows } = await pool.query<{ tool_catalog: { name: string; description: string; annotations: unknown }[] }>(
          `SELECT tool_catalog FROM mcp_servers WHERE id = $1`,
          [s.id],
        );
        tools = rows[0]?.tool_catalog ?? [];
      } else {
        tools = await upstreams.toolsFor(s);
      }
      out.push({
        serverId: s.id,
        slug: s.slug,
        name: s.name,
        authMode: s.auth_mode,
        isSystem: s.is_system,
        level: ctx.grants.get(s.id) ?? "none",
        tools: tools.map((t) => {
          const rule = ctx.userTools.get(`${s.id}|${t.name}`) ?? "inherit";
          const decision = explainCall(ctx, s.id, t as never);
          return {
            name: t.name,
            description: (t.description as string) ?? "",
            class: effectiveClass(t as never, overrides.get(`${s.id}|${t.name}`)),
            rule,
            allowed: decision.allowed,
            reason: decision.reason,
          };
        }),
      });
    }
    return out;
  });

  app.put<{ Params: { id: string }; Body: { serverId?: string; tool?: string; access?: string } }>("/api/users/:id/tool-access", async (req, reply) => {
    if (!(await currentUser(req, reply, "tools.manage"))) return;
    const { serverId = "", tool = "", access = "inherit" } = req.body ?? {};
    if (!serverId || !tool) return reply.code(400).send({ error: "Server and tool are required" });
    if (!["inherit", "allow", "deny"].includes(access)) return reply.code(400).send({ error: "Access must be inherit, allow or deny" });
    if (access === "inherit") {
      await pool.query(`DELETE FROM user_tool_access WHERE user_id = $1 AND server_id = $2 AND tool = $3`, [req.params.id, serverId, tool]);
    } else {
      await pool.query(
        `INSERT INTO user_tool_access (user_id, server_id, tool, access) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, server_id, tool) DO UPDATE SET access = $4`,
        [req.params.id, serverId, tool, access],
      );
    }
    return { ok: true };
  });

  // ---- Chat: saved conversations, one member's own ----------------------------------
  app.get("/api/chat/conversations", async (req, reply) => {
    const user = await currentUser(req, reply, "chat.use");
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              (SELECT count(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM chat_conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 200`,
      [user.id],
    );
    return rows;
  });

  app.post("/api/chat/conversations", async (req, reply) => {
    const user = await currentUser(req, reply, "chat.use");
    if (!user) return;
    const id = await ensureConversation(user, null, "");
    return reply.code(201).send({ id });
  });

  app.get<{ Params: { id: string } }>("/api/chat/conversations/:id", async (req, reply) => {
    const user = await currentUser(req, reply, "chat.use");
    if (!user) return;
    const { rows: conv } = await pool.query(`SELECT id, title, created_at FROM chat_conversations WHERE id = $1 AND user_id = $2`, [req.params.id, user.id]);
    if (!conv[0]) return reply.code(404).send({ error: "Conversation not found" });
    const { rows } = await pool.query(
      `SELECT id, role, content, meta, created_at FROM chat_messages WHERE conversation_id = $1 ORDER BY id`,
      [req.params.id],
    );
    // Internal fields (raw provider messages, tool results sent to the model) stay on the server.
    const messages = rows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      model: (m.meta as { model?: string }).model ?? null,
      toolCalls: ((m.meta as { toolPreview?: unknown[] }).toolPreview ?? []) as unknown[],
    }));
    return { id: conv[0].id, title: conv[0].title, messages };
  });

  app.delete<{ Params: { id: string } }>("/api/chat/conversations/:id", async (req, reply) => {
    const user = await currentUser(req, reply, "chat.use");
    if (!user) return;
    const { rowCount } = await pool.query(`DELETE FROM chat_conversations WHERE id = $1 AND user_id = $2`, [req.params.id, user.id]);
    if (!rowCount) return reply.code(404).send({ error: "Conversation not found" });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { message?: string } }>("/api/chat/conversations/:id/messages", async (req, reply) => {
    const user = await currentUser(req, reply, "chat.use");
    if (!user) return;
    const message = (req.body?.message ?? "").trim();
    if (!message) return reply.code(400).send({ error: "Message is required" });
    try {
      return await runChat(user, req.params.id, message);
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Chat failed" });
    }
  });

  // Starts a new conversation with the first message.
  app.post<{ Body: { message?: string } }>("/api/chat", async (req, reply) => {
    const user = await currentUser(req, reply, "chat.use");
    if (!user) return;
    const message = (req.body?.message ?? "").trim();
    if (!message) return reply.code(400).send({ error: "Message is required" });
    try {
      return await runChat(user, null, message);
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Chat failed" });
    }
  });

  app.get("/api/tools", async (req, reply) => {
    const user = await currentUser(req, reply, "chat.use");
    if (!user) return;
    const tools = await listExposedTools(user);
    return tools.map((t) => ({ name: t.name, description: t.description ?? "" }));
  });
}

// The server card shown to one viewer. For OAuth servers the status belongs to the
// viewer's own connection, and the tool list is theirs too.
function serverView(
  s: UpstreamRow,
  tools: { name: string; description?: string }[],
  status: string,
  error: string | null,
  toolCount: number,
  overrides: Map<string, ToolOverride>,
) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    url: s.url,
    enabled: s.enabled,
    chatEnabled: s.chat_enabled,
    isSystem: s.is_system,
    authMode: s.auth_mode,
    providerId: s.provider_id,
    hasCredential: Boolean(s.credential_enc),
    authHeader: s.auth_header,
    status,
    error,
    checkedAt: Date.now(),
    toolCount,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      class: effectiveClass(t as never, overrides.get(`${s.id}|${t.name}`)),
      override: overrides.get(`${s.id}|${t.name}`) ?? "auto",
    })),
  };
}

async function loadOverrides(): Promise<Map<string, ToolOverride>> {
  const { rows } = await pool.query<{ server_id: string; tool: string; access: ToolOverride }>(`SELECT server_id, tool, access FROM tool_overrides`);
  return new Map(rows.map((r) => [`${r.server_id}|${r.tool}`, r.access]));
}

// Is there another active member who can manage roles? The last one can't be removed.
async function otherActiveRoleManager(excludeId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE NOT u.disabled AND u.id <> $1 AND 'roles.manage' = ANY(r.permissions) LIMIT 1`,
    [excludeId],
  );
  return rows.length > 0;
}

interface ServerInput {
  authMode?: string;
  providerId?: string;
  chatEnabled?: boolean;
  slug?: string;
  name?: string;
  url?: string;
  authHeader?: string;
  credential?: string;
  enabled?: boolean;
}

// Checks one provider's settings. Returns the cleaned values, or an error message.
function validateProviderInput(
  b: Record<string, string | boolean | undefined>,
  creating: boolean,
):
  | { slug: string; name: string; authorizeUrl: string; tokenUrl: string; scopes: string; scopeParam: string; pkce: boolean; tokenPath: string; clientId: string; clientSecret: string }
  | string {
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  const slug = str("slug").toLowerCase();
  if (creating && !/^[a-z0-9-]{2,40}$/.test(slug)) return "Slug must be 2-40 characters: lowercase letters, digits, hyphens";
  const name = str("name");
  if (!name) return "Name is required";
  const authorizeUrl = str("authorizeUrl");
  const tokenUrl = str("tokenUrl");
  for (const u of [authorizeUrl, tokenUrl]) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "localhost")) return "Sign-in URLs must use https";
    } catch {
      return "Sign-in URLs must be valid addresses";
    }
  }
  const clientId = str("clientId");
  if (creating && !clientId) return "Client ID is required";
  const clientSecret = str("clientSecret");
  if (creating && !clientSecret) return "Client secret is required";
  const scopeParam = str("scopeParam") || "scope";
  if (!["scope", "user_scope"].includes(scopeParam)) return "Scope parameter must be scope or user_scope";
  return {
    slug,
    name,
    authorizeUrl,
    tokenUrl,
    scopes: str("scopes"),
    scopeParam,
    pkce: b.pkce === true || b.pkce === "true",
    tokenPath: str("tokenPath") || "access_token",
    clientId,
    clientSecret,
  };
}

async function validateServerInput(input: ServerInput, creating: boolean): Promise<string | null> {
  if (creating) {
    if (!input.slug || !SLUG_RE.test(input.slug)) return "Slug must be 2-40 chars: lowercase letters, digits, hyphens";
    if (!input.name?.trim()) return "Name is required";
    if (!input.url) return "URL is required";
  }
  if (input.authHeader && !/^[A-Za-z0-9-]+$/.test(input.authHeader)) return "Header name is invalid";
  if (input.url !== undefined) {
    try {
      validateUpstreamUrl(input.url);
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid URL";
    }
  }
  return null;
}

// Serves the built React dashboard, with SPA fallback to index.html.
export async function serveDashboard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const root = resolve(config.dashboardDir);
  const rel = normalize(decodeURIComponent(req.url.split("?")[0]));
  let file = join(root, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(root)) return void reply.code(403).send();
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
  } catch {
    file = join(root, "index.html");
  }
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  try {
    const body = await readFile(file);
    reply.type(types[extname(file)] ?? "application/octet-stream").send(body);
  } catch {
    reply.code(404).send("dashboard not built");
  }
}

