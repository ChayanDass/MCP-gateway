import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { pool } from "./db.js";
import { createSession, identityFromSession, sessionCookie, type Identity } from "./identity.js";
import { sha256, verifyPassword } from "./crypto.js";

// OAuth 2.1 authorization server for MCP clients (the MCP authorization spec).
// A client registers itself, the member signs in and approves once in the browser,
// and the client receives short-lived tokens. Refresh tokens rotate on use.
// Clients are public (no secret); PKCE with S256 is required.

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

export function issuer(): string {
  return (config.publicBaseUrl || "http://localhost:8080").replace(/\/$/, "");
}

const newSecret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

// Only loopback http and https redirects are accepted, to stop open redirects.
function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6fa;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#161b26}
.box{width:100%;max-width:400px;background:#fff;border:1px solid #e3e6ee;border-radius:14px;padding:26px;box-shadow:0 1px 3px rgba(16,24,40,.08)}
h1{font-size:19px;margin:0 0 6px}p{margin:8px 0;color:#475467}
label{display:grid;gap:5px;font-size:13px;color:#475467;margin-top:12px}
input{font:inherit;padding:9px 11px;border:1px solid #d0d5dd;border-radius:9px}
.row{display:flex;gap:10px;margin-top:18px}button{flex:1;font:inherit;font-weight:600;padding:10px;border-radius:9px;border:1px solid #d0d5dd;background:#fff;cursor:pointer}
button.primary{background:#4f46e5;border-color:#4f46e5;color:#fff}.muted{color:#667085;font-size:13px}code{background:#f0f2f7;padding:1px 6px;border-radius:6px}
</style></head><body><div class="box">${body}</div></body></html>`;
}

// The OAuth parameters carried through the login and consent steps.
interface AuthParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  response_type: string;
  state?: string;
}

function paramsFrom(src: Record<string, unknown>): AuthParams {
  const get = (k: string) => (typeof src[k] === "string" ? (src[k] as string) : "");
  return {
    client_id: get("client_id"),
    redirect_uri: get("redirect_uri"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
    response_type: get("response_type"),
    state: get("state") || undefined,
  };
}

async function validateRequest(p: AuthParams): Promise<{ ok: true; clientName: string } | { ok: false; error: string }> {
  const { rows } = await pool.query<{ client_name: string; redirect_uris: string[] }>(
    `SELECT client_name, redirect_uris FROM oauth_clients WHERE client_id = $1`,
    [p.client_id],
  );
  if (!rows[0]) return { ok: false, error: "This application is not registered with the gateway." };
  if (!rows[0].redirect_uris.includes(p.redirect_uri)) return { ok: false, error: "The return address does not match the one the application registered." };
  if (p.response_type !== "code") return { ok: false, error: "Only the authorization-code flow is supported." };
  if (p.code_challenge_method !== "S256" || !p.code_challenge) return { ok: false, error: "PKCE with S256 is required." };
  return { ok: true, clientName: rows[0].client_name };
}

function queryString(p: AuthParams): string {
  return new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();
}

function loginForm(p: AuthParams, clientName: string, error?: string): string {
  const hidden = Object.entries(p)
    .filter(([, v]) => v)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`)
    .join("");
  return page(
    "Sign in to the MCP gateway",
    `<h1>Sign in to the MCP gateway</h1>
     <p>${esc(clientName)} wants to use the gateway's tools on your behalf.</p>
     ${error ? `<p style="color:#b42318">${esc(error)}</p>` : ""}
     <form method="post" action="/oauth/authorize/login">${hidden}
       <label>Email<input type="email" name="email" required autocomplete="username"></label>
       <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
       <div class="row"><button class="primary" type="submit">Sign in</button></div>
     </form>`,
  );
}

function consentForm(p: AuthParams, clientName: string, user: Identity): string {
  const hidden = Object.entries(p)
    .filter(([, v]) => v)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`)
    .join("");
  return page(
    "Allow access",
    `<h1>Allow ${esc(clientName)}?</h1>
     <p>Signed in as <strong>${esc(user.email)}</strong>.</p>
     <p class="muted">It can use the tools your account is allowed to use, through the MCP gateway. Every call is logged under your name. You can revoke access at any time.</p>
     <form method="post" action="/oauth/authorize/decision">${hidden}
       <div class="row">
         <button type="submit" name="decision" value="deny">Deny</button>
         <button class="primary" type="submit" name="decision" value="allow">Allow</button>
       </div>
     </form>`,
  );
}

export function registerOAuthRoutes(app: FastifyInstance): void {
  // ---- Discovery ----------------------------------------------------------------
  // RFC 9728: the resource metadata, at the root and at the path of the resource (/mcp).
  const protectedResource = async () => ({
    resource: `${issuer()}/mcp`,
    authorization_servers: [issuer()],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  });
  app.get("/.well-known/oauth-protected-resource", async () => protectedResource());
  app.get("/.well-known/oauth-protected-resource/mcp", async () => protectedResource());

  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer: issuer(),
    authorization_endpoint: `${issuer()}/oauth/authorize`,
    token_endpoint: `${issuer()}/oauth/token`,
    registration_endpoint: `${issuer()}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  }));

  // ---- Dynamic client registration (RFC 7591) -----------------------------------
  app.post<{ Body: { client_name?: string; redirect_uris?: string[] } }>("/oauth/register", async (req, reply) => {
    const name = (req.body?.client_name ?? "").trim().slice(0, 100) || "MCP client";
    const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
    if (uris.length === 0 || !uris.every((u) => typeof u === "string" && redirectAllowed(u))) {
      return reply.code(400).send({ error: "invalid_redirect_uri", error_description: "Redirect addresses must be https, or http on localhost." });
    }
    const clientId = `kmcpc_${randomBytes(16).toString("hex")}`;
    await pool.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3::jsonb)`, [clientId, name, JSON.stringify(uris)]);
    return reply.code(201).send({
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // ---- Authorization: login and consent in the browser --------------------------
  app.get("/oauth/authorize", async (req, reply: FastifyReply) => {
    const p = paramsFrom(req.query as Record<string, unknown>);
    const v = await validateRequest(p);
    if (!v.ok) return reply.code(400).type("text/html").send(page("Cannot sign in", `<h1>Cannot sign in</h1><p>${esc(v.error)}</p>`));
    const user = await identityFromSession(req.raw);
    if (!user) return reply.type("text/html").send(loginForm(p, v.clientName));
    return reply.type("text/html").send(consentForm(p, v.clientName, user));
  });

  app.post("/oauth/authorize/login", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = paramsFrom(body);
    const v = await validateRequest(p);
    if (!v.ok) return reply.code(400).type("text/html").send(page("Cannot sign in", `<h1>Cannot sign in</h1><p>${esc(v.error)}</p>`));
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const { rows } = await pool.query<{ id: string; password_hash: string | null; disabled: boolean }>(
      `SELECT id, password_hash, disabled FROM users WHERE email = $1`,
      [email],
    );
    const u = rows[0];
    const ok = u && u.password_hash && !u.disabled && (await verifyPassword(password, u.password_hash));
    if (!ok) return reply.code(401).type("text/html").send(loginForm(p, v.clientName, "Wrong email or password."));
    const token = await createSession(u.id);
    reply.header("Set-Cookie", sessionCookie(token, config.publicBaseUrl.startsWith("https://")));
    return reply.redirect(`/oauth/authorize?${queryString(p)}`);
  });

  app.post("/oauth/authorize/decision", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const p = paramsFrom(body);
    const v = await validateRequest(p);
    if (!v.ok) return reply.code(400).type("text/html").send(page("Cannot sign in", `<h1>Cannot sign in</h1><p>${esc(v.error)}</p>`));
    const user = await identityFromSession(req.raw);
    if (!user) return reply.redirect(`/oauth/authorize?${queryString(p)}`);
    const back = new URL(p.redirect_uri);
    if (body.decision !== "allow") {
      back.searchParams.set("error", "access_denied");
      if (p.state) back.searchParams.set("state", p.state);
      return reply.redirect(back.toString());
    }
    const code = newSecret("kmcpz_");
    await pool.query(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [sha256(code), p.client_id, user.id, p.redirect_uri, p.code_challenge, new Date(Date.now() + CODE_TTL_MS)],
    );
    back.searchParams.set("code", code);
    if (p.state) back.searchParams.set("state", p.state);
    return reply.redirect(back.toString());
  });

  // ---- Token endpoint ------------------------------------------------------------
  app.post("/oauth/token", async (req: FastifyRequest, reply: FastifyReply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const invalid = (desc: string) => reply.code(400).send({ error: "invalid_grant", error_description: desc });

    if (b.grant_type === "authorization_code") {
      const { rows } = await pool.query<{ client_id: string; user_id: string; redirect_uri: string; code_challenge: string; expires_at: Date }>(
        `DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING client_id, user_id, redirect_uri, code_challenge, expires_at`,
        [sha256(b.code ?? "")],
      );
      const c = rows[0];
      if (!c || c.expires_at < new Date()) return invalid("The code is invalid or expired.");
      if (c.client_id !== b.client_id || c.redirect_uri !== b.redirect_uri) return invalid("The code was issued to a different client or address.");
      const challenge = createHash("sha256").update(b.code_verifier ?? "").digest("base64url");
      if (!timingSafeEqual(Buffer.from(challenge), Buffer.from(c.code_challenge))) return invalid("PKCE verification failed.");
      return issueTokens(c.client_id, c.user_id, reply);
    }

    if (b.grant_type === "refresh_token") {
      const { rows } = await pool.query<{ client_id: string; user_id: string }>(
        `UPDATE oauth_tokens SET revoked_at = now()
          WHERE token_hash = $1 AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > now()
          RETURNING client_id, user_id`,
        [sha256(b.refresh_token ?? "")],
      );
      if (!rows[0] || b.client_id !== rows[0].client_id) return invalid("The refresh token is invalid or expired.");
      return issueTokens(rows[0].client_id, rows[0].user_id, reply);
    }

    return reply.code(400).send({ error: "unsupported_grant_type" });
  });
}

async function issueTokens(clientId: string, userId: string, reply: FastifyReply) {
  const access = newSecret("kmcpa_");
  const refresh = newSecret("kmcpr_");
  await pool.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at) VALUES ($1, 'access', $2, $3, $4), ($5, 'refresh', $2, $3, $6)`,
    [sha256(access), clientId, userId, new Date(Date.now() + ACCESS_TTL_MS), sha256(refresh), new Date(Date.now() + REFRESH_TTL_MS)],
  );
  return reply.header("Cache-Control", "no-store").send({
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
  });
}

// Resolves an OAuth access token to the member it was issued to.
export async function identityFromOAuthAccess(token: string): Promise<Identity | null> {
  const { rows } = await pool.query<Identity>(
    `SELECT u.id, u.email, u.name, u.role
       FROM oauth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now() AND NOT u.disabled`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}
