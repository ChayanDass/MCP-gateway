import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { newToken, hashPassword, sha256, verifyPassword, encrypt } from "./crypto.js";
import { pool } from "./db.js";
import { handleMcpRequest } from "./mcp.js";
import { runChat } from "./chat.js";
import { loadLlm, llmStep } from "./llm.js";
import { verifyGoogleCredential } from "./google.js";
import { CATALOG, catalogEntry } from "./catalog.js";
import { exchangeCode, finishFlow, providerConfigured, startFlow } from "./oauth.js";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  identityFromApiKey,
  identityFromSession,
  sessionCookie,
  type Identity,
} from "./identity.js";
import { upstreams, type UpstreamRow } from "./upstreams.js";
import { validateUpstreamUrl } from "./ssrf.js";
import { listExposedTools, oauthTokensFor } from "./tools.js";
import { effectiveClass, type ToolOverride } from "./access.js";

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
async function currentUser(req: FastifyRequest, reply: FastifyReply, adminOnly = false): Promise<Identity | null> {
  const user = await identityFromSession(req.raw);
  if (!user) {
    reply.code(401).send({ error: "Not signed in" });
    return null;
  }
  if (adminOnly && user.role !== "admin") {
    reply.code(403).send({ error: "Admins only" });
    return null;
  }
  return user;
}

export function registerApi(app: FastifyInstance): void {
  // ---- MCP endpoint: the single URL external clients use -------------------
  app.all("/mcp", async (req, reply) => {
    const user = await identityFromApiKey(req.headers.authorization);
    if (!user) {
      return reply
        .code(401)
        .header("WWW-Authenticate", 'Bearer realm="kube-mcp"')
        .send({ error: "Missing or revoked API key" });
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
    const { rows } = await pool.query<Identity & { password_hash: string | null; disabled: boolean }>(
      `SELECT id, email, name, role, password_hash, disabled FROM users WHERE email = $1`,
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
    return { id: u.id, email: u.email, name: u.name, role: u.role };
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
    const { rows } = await pool.query<Identity & { disabled: boolean }>(
      `SELECT id, email, name, role, disabled FROM users WHERE email = $1`,
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
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  });

  // ---- MCP servers ----------------------------------------------------------
  app.get("/api/servers", async (req, reply) => {
    const viewer = await currentUser(req, reply);
    if (!viewer) return;
    const servers = await upstreams.loadServers();
    const overrides = await loadOverrides();
    const myTokens = await oauthTokensFor(viewer.id);
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
          return serverView(s, probe.tools, "connected", null, probe.tools.length, overrides);
        }
        const tools = s.enabled ? await upstreams.toolsFor(s) : [];
        const st = upstreams.status(s.id);
        return {
          id: s.id,
          slug: s.slug,
          name: s.name,
          url: s.url,
          enabled: s.enabled,
          chatEnabled: s.chat_enabled,
          isSystem: s.is_system,
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
    if (!(await currentUser(req, reply, true))) return;
    const input = req.body ?? ({} as ServerInput);
    const problem = await validateServerInput(input, true);
    if (problem) return reply.code(400).send({ error: problem });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO mcp_servers (slug, name, url, auth_header, credential_enc, enabled, chat_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        input.slug,
        input.name,
        validateUpstreamUrl(input.url!),
        input.authHeader || null,
        input.credential ? encrypt(input.credential) : null,
        input.enabled ?? true,
        input.chatEnabled ?? false,
      ],
    );
    void upstreams.refreshAll();
    return reply.code(201).send({ id: rows[0].id });
  });

  app.patch<{ Params: { id: string }; Body: ServerInput }>("/api/servers/:id", async (req, reply) => {
    if (!(await currentUser(req, reply, true))) return;
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
    if (!(await currentUser(req, reply, true))) return;
    const { rowCount } = await pool.query(`DELETE FROM mcp_servers WHERE id = $1`, [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: "Server not found" });
    upstreams.invalidate(req.params.id);
    return { ok: true };
  });

  // Per-tool override: auto (classified by annotations or name), read, write or blocked.
  app.put<{ Params: { id: string }; Body: { tool?: string; access?: string } }>("/api/servers/:id/tools", async (req, reply) => {
    if (!(await currentUser(req, reply, true))) return;
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
    if (!(await currentUser(req, reply, true))) return;
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at,
              count(k.id) FILTER (WHERE k.revoked_at IS NULL) AS active_keys
         FROM users u LEFT JOIN api_keys k ON k.user_id = u.id
        GROUP BY u.id ORDER BY u.created_at`,
    );
    return rows;
  });

  // Access per server for one user: none, read or write. Admins always have full access.
  app.get<{ Params: { id: string } }>("/api/users/:id/access", async (req, reply) => {
    if (!(await currentUser(req, reply, true))) return;
    const { rows } = await pool.query(
      `SELECT s.id AS server_id, s.slug, s.name, s.is_system, COALESCE(a.access, 'none') AS access
         FROM mcp_servers s LEFT JOIN user_server_access a ON a.server_id = s.id AND a.user_id = $1
        ORDER BY s.is_system DESC, s.name`,
      [req.params.id],
    );
    return rows;
  });

  app.put<{ Params: { id: string }; Body: { serverId?: string; access?: string } }>("/api/users/:id/access", async (req, reply) => {
    const admin = await currentUser(req, reply, true);
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
  app.post<{ Body: { email?: string; name?: string; role?: string; password?: string; access?: Record<string, string> } }>("/api/users", async (req, reply) => {
    if (!(await currentUser(req, reply, true))) return;
    const { email = "", name = "", role = "member", password = "", access = {} } = req.body ?? {};
    if (!email.includes("@") || !name.trim()) return reply.code(400).send({ error: "Email and name are required" });
    if (role !== "admin" && role !== "member") return reply.code(400).send({ error: "Role must be admin or member" });
    if (password.length < 8) return reply.code(400).send({ error: "Password must be at least 8 characters" });
    for (const level of Object.values(access)) {
      if (!["none", "read", "write"].includes(level)) return reply.code(400).send({ error: "Access must be none, read or write" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [email.trim().toLowerCase(), name.trim(), role, await hashPassword(password)],
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "A user with that email already exists" });
      }
      for (const [serverId, level] of Object.entries(access)) {
        if (level === "none") continue;
        await client.query(
          `INSERT INTO user_server_access (user_id, server_id, access) VALUES ($1, $2, $3)`,
          [rows[0].id, serverId, level],
        );
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
  app.patch<{ Params: { id: string }; Body: { name?: string; disabled?: boolean; role?: string } }>("/api/users/:id", async (req, reply) => {
    const admin = await currentUser(req, reply, true);
    if (!admin) return;
    const { name, disabled, role } = req.body ?? {};
    if (role !== undefined && role !== "admin" && role !== "member") return reply.code(400).send({ error: "Bad role" });
    if (name !== undefined && !name.trim()) return reply.code(400).send({ error: "Name cannot be empty" });
    if (req.params.id === admin.id && (disabled || (role && role !== "admin"))) {
      return reply.code(400).send({ error: "You cannot demote or disable yourself" });
    }
    const losesAdmin = (role !== undefined && role !== "admin") || disabled === true;
    if (losesAdmin && !(await otherActiveAdminExists(req.params.id))) {
      return reply.code(400).send({ error: "At least one active admin must remain" });
    }
    await pool.query(
      `UPDATE users SET name = COALESCE($2, name), disabled = COALESCE($3, disabled), role = COALESCE($4, role) WHERE id = $1`,
      [req.params.id, name?.trim() ?? null, disabled ?? null, role ?? null],
    );
    if (disabled) await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [req.params.id]);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { password?: string } }>("/api/users/:id/password", async (req, reply) => {
    if (!(await currentUser(req, reply, true))) return;
    const password = req.body?.password ?? "";
    if (password.length < 8) return reply.code(400).send({ error: "Password must be at least 8 characters" });
    const { rowCount } = await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [req.params.id, await hashPassword(password)]);
    if (!rowCount) return reply.code(404).send({ error: "User not found" });
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [req.params.id]);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
    const admin = await currentUser(req, reply, true);
    if (!admin) return;
    if (req.params.id === admin.id) return reply.code(400).send({ error: "You cannot delete yourself" });
    const { rows } = await pool.query<{ role: string; disabled: boolean }>(`SELECT role, disabled FROM users WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: "User not found" });
    if (rows[0].role === "admin" && !(await otherActiveAdminExists(req.params.id))) {
      return reply.code(400).send({ error: "At least one active admin must remain" });
    }
    await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
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
  app.post<{ Params: { id: string }; Body: { label?: string } }>("/api/users/:id/keys", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    if (user.id !== req.params.id && user.role !== "admin") return reply.code(403).send({ error: "Not allowed" });
    const label = (req.body?.label ?? "").trim() || "api key";
    const token = newToken("kmcp_");
    await pool.query(`INSERT INTO api_keys (user_id, label, prefix, key_hash) VALUES ($1, $2, $3, $4)`, [
      req.params.id,
      label,
      token.slice(0, 13),
      sha256(token),
    ]);
    // The plaintext key is returned exactly once. Only its hash is stored.
    return reply.code(201).send({ key: token });
  });

  app.delete<{ Params: { id: string } }>("/api/keys/:id", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    const { rowCount } = await pool.query(
      `UPDATE api_keys SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL AND ($2 = 'admin' OR user_id = $3)`,
      [req.params.id, user.role, user.id],
    );
    if (!rowCount) return reply.code(404).send({ error: "Key not found or not yours" });
    return { ok: true };
  });

  // ---- Audit ----------------------------------------------------------------
  app.get<{ Querystring: { limit?: string } }>("/api/audit", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const { rows } = await pool.query(
      `SELECT id, ts, user_email, server_slug, tool, source, duration_ms, outcome, error
         FROM audit_log WHERE ($1 = 'admin' OR user_id = $2)
        ORDER BY ts DESC LIMIT $3`,
      [user.role, user.id, limit],
    );
    return rows;
  });

  // ---- Model settings (admin) -----------------------------------------------
  // The API key is write-only: it is encrypted on save and never returned.
  app.get("/api/llm", async (req, reply) => {
    if (!(await currentUser(req, reply, true))) return;
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
    if (!(await currentUser(req, reply, true))) return;
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
    if (!(await currentUser(req, reply, true))) return;
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
    if (!(await currentUser(req, reply, true))) return;
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
    const admin = user.role === "admin";
    const [servers, calls, recent, members, model] = await Promise.all([
      pool.query<{ total: string; enabled: string; system: string }>(
        `SELECT count(*) AS total, count(*) FILTER (WHERE enabled) AS enabled, count(*) FILTER (WHERE is_system) AS system FROM mcp_servers`,
      ),
      pool.query<{ total: string; errors: string; denied: string }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE outcome NOT IN ('ok')) AS errors,
                count(*) FILTER (WHERE outcome = 'denied') AS denied
           FROM audit_log WHERE ts > now() - interval '24 hours' AND ($1 OR user_id = $2)`,
        [admin, user.id],
      ),
      pool.query(
        `SELECT ts, user_email, server_slug, tool, source, outcome, duration_ms
           FROM audit_log WHERE ($1 OR user_id = $2) ORDER BY ts DESC LIMIT 6`,
        [admin, user.id],
      ),
      admin
        ? pool.query<{ total: string; admins: string }>(`SELECT count(*) AS total, count(*) FILTER (WHERE role = 'admin') AS admins FROM users WHERE NOT disabled`)
        : Promise.resolve({ rows: [] as { total: string; admins: string }[] }),
      admin ? loadLlm() : Promise.resolve(null),
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

  // ---- Catalogue of MCP servers ------------------------------------------------
  app.get("/api/catalog", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    const { rows: installed } = await pool.query<{ id: string; slug: string; enabled: boolean }>(
      `SELECT id, slug, enabled FROM mcp_servers`,
    );
    const { rows: mine } = await pool.query<{ server_id: string }>(`SELECT server_id FROM user_oauth_tokens WHERE user_id = $1`, [user.id]);
    const connected = new Set(mine.map((r) => r.server_id));
    return CATALOG.map((c) => {
      const row = installed.find((i) => i.slug === c.slug);
      return {
        key: c.key,
        slug: c.slug,
        name: c.name,
        description: c.description,
        url: c.url,
        authMode: c.authMode,
        provider: c.provider ?? null,
        providerReady: c.provider ? providerConfigured(c.provider) : true,
        installed: Boolean(row),
        enabled: row?.enabled ?? false,
        serverId: row?.id ?? null,
        connected: row ? connected.has(row.id) : false,
      };
    });
  });

  app.post<{ Params: { key: string } }>("/api/catalog/:key/install", async (req, reply) => {
    if (!(await currentUser(req, reply, true))) return;
    const entry = catalogEntry(req.params.key);
    if (!entry) return reply.code(404).send({ error: "Not in the catalogue" });
    if (entry.provider && !providerConfigured(entry.provider)) {
      return reply.code(400).send({ error: `${entry.name} sign-in is not configured on the server yet` });
    }
    await pool.query(
      `INSERT INTO mcp_servers (slug, name, url, enabled, is_system, chat_enabled, auth_mode)
       VALUES ($1, $2, $3, true, $4, false, $5)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, auth_mode = EXCLUDED.auth_mode, credential_enc = NULL, auth_header = NULL`,
      [entry.slug, entry.name, entry.url, entry.system ?? false, entry.authMode],
    );
    upstreams.invalidate((await pool.query<{ id: string }>(`SELECT id FROM mcp_servers WHERE slug = $1`, [entry.slug])).rows[0].id);
    return reply.code(201).send({ ok: true });
  });

  // ---- Per-member OAuth connections ---------------------------------------------
  // Start: the member clicks Connect and is sent to the provider.
  app.get<{ Params: { provider: string } }>("/api/oauth/:provider/start", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    if (req.params.provider !== "github" || !providerConfigured("github")) {
      return reply.code(400).send({ error: "This sign-in is not configured" });
    }
    return reply.redirect(startFlow("github", user.id));
  });

  // Callback: the provider sends the member back with a code. The state was
  // issued to this member only, and can be used once.
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/oauth/:provider/callback",
    async (req, reply) => {
      const back = (q: string) => reply.redirect(`/#/servers?${q}`);
      if (req.params.provider !== "github") return back("oauth=failed&reason=unknown_provider");
      if (req.query.error) return back("oauth=failed&reason=denied");
      const flow = req.query.state ? finishFlow("github", req.query.state) : null;
      if (!flow || !req.query.code) return back("oauth=failed&reason=expired");
      try {
        const token = await exchangeCode("github", req.query.code, flow.verifier);
        const { rows } = await pool.query<{ id: string }>(`SELECT id FROM mcp_servers WHERE slug = 'github' AND auth_mode = 'oauth'`);
        if (!rows[0]) return back("oauth=failed&reason=not_installed");
        await pool.query(
          `INSERT INTO user_oauth_tokens (user_id, server_id, access_enc, scope, connected_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (user_id, server_id) DO UPDATE SET access_enc = $3, scope = $4, connected_at = now()`,
          [flow.userId, rows[0].id, encrypt(token.accessToken), token.scope],
        );
        return back("oauth=connected&provider=github");
      } catch (e) {
        req.log.warn({ err: e instanceof Error ? e.message : e }, "github oauth exchange failed");
        return back("oauth=failed&reason=exchange");
      }
    },
  );

  app.delete<{ Params: { provider: string } }>("/api/oauth/:provider", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    await pool.query(
      `DELETE FROM user_oauth_tokens WHERE user_id = $1 AND server_id IN (SELECT id FROM mcp_servers WHERE slug = $2)`,
      [user.id, req.params.provider],
    );
    return { ok: true };
  });

  // ---- Chat -----------------------------------------------------------------
  app.post<{ Body: { message?: string } }>("/api/chat", async (req, reply) => {
    const user = await currentUser(req, reply);
    if (!user) return;
    const message = (req.body?.message ?? "").trim();
    if (!message) return reply.code(400).send({ error: "Message is required" });
    try {
      return await runChat(user, message);
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : "Chat failed" });
    }
  });

  app.get("/api/tools", async (req, reply) => {
    const user = await currentUser(req, reply);
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

async function otherActiveAdminExists(excludeId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE role = 'admin' AND NOT disabled AND id <> $1 LIMIT 1`, [excludeId]);
  return rows.length > 0;
}

interface ServerInput {
  chatEnabled?: boolean;
  slug?: string;
  name?: string;
  url?: string;
  authHeader?: string;
  credential?: string;
  enabled?: boolean;
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

