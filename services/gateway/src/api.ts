import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { newToken, hashPassword, sha256, verifyPassword, encrypt } from "./crypto.js";
import { pool } from "./db.js";
import { handleMcpRequest } from "./mcp.js";
import { runChat } from "./chat.js";
import { loadLlm, llmStep } from "./llm.js";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  identityFromApiKey,
  identityFromSession,
  sessionCookie,
  type Identity,
} from "./identity.js";
import { upstreams } from "./upstreams.js";
import { validateUpstreamUrl } from "./ssrf.js";
import { listExposedTools } from "./tools.js";

const SLUG_RE = /^[a-z0-9-]{2,40}$/;

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
    const { email = "", password = "" } = req.body ?? {};
    const { rows } = await pool.query<Identity & { password_hash: string | null; disabled: boolean }>(
      `SELECT id, email, name, role, password_hash, disabled FROM users WHERE email = $1`,
      [email.trim().toLowerCase()],
    );
    const u = rows[0];
    const ok = u && u.password_hash && !u.disabled && (await verifyPassword(password, u.password_hash));
    if (!ok) return reply.code(401).send({ error: "Invalid email or password" });
    const token = await createSession(u.id);
    reply.header("Set-Cookie", sessionCookie(token));
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await deleteSession(req.raw);
    reply.header("Set-Cookie", clearSessionCookie());
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const user = await currentUser(req, reply);
    return user ?? undefined;
  });

  app.get("/api/gateway", async () => ({
    mcpPath: "/mcp",
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  }));

  // ---- MCP servers ----------------------------------------------------------
  app.get("/api/servers", async (req, reply) => {
    if (!(await currentUser(req, reply))) return;
    const servers = await upstreams.loadServers();
    const views = await Promise.all(
      servers.map(async (s) => {
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
          tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
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

  app.post<{ Body: { email?: string; name?: string; role?: string; password?: string } }>("/api/users", async (req, reply) => {
    if (!(await currentUser(req, reply, true))) return;
    const { email = "", name = "", role = "member", password = "" } = req.body ?? {};
    if (!email.includes("@") || !name.trim()) return reply.code(400).send({ error: "Email and name are required" });
    if (role !== "admin" && role !== "member") return reply.code(400).send({ error: "Role must be admin or member" });
    if (password.length < 8) return reply.code(400).send({ error: "Password must be at least 8 characters" });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email.trim().toLowerCase(), name.trim(), role, await hashPassword(password)],
    );
    if (!rows[0]) return reply.code(409).send({ error: "A user with that email already exists" });
    return reply.code(201).send({ id: rows[0].id });
  });

  app.patch<{ Params: { id: string }; Body: { disabled?: boolean; role?: string } }>("/api/users/:id", async (req, reply) => {
    const admin = await currentUser(req, reply, true);
    if (!admin) return;
    const { disabled, role } = req.body ?? {};
    if (role !== undefined && role !== "admin" && role !== "member") return reply.code(400).send({ error: "Bad role" });
    if (req.params.id === admin.id && (disabled || (role && role !== "admin"))) {
      return reply.code(400).send({ error: "You cannot demote or disable yourself" });
    }
    await pool.query(
      `UPDATE users SET disabled = COALESCE($2, disabled), role = COALESCE($3, role) WHERE id = $1`,
      [req.params.id, disabled ?? null, role ?? null],
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
    return cfg
      ? { configured: true, provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, hasKey: Boolean(cfg.apiKey) }
      : { configured: false, provider: "openai", baseUrl: "", model: "", hasKey: false };
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
    if (!(await currentUser(req, reply))) return;
    const tools = await listExposedTools();
    return tools.map((t) => ({ name: t.name, description: t.description ?? "" }));
  });
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

