import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";
import { pool } from "./db.js";

// Generic OAuth authorization-code flow for connecting a member's own account to
// an MCP server. Providers (endpoints, scopes, client credentials) live in the
// database and are managed by admins, so nothing about a specific service is
// hardcoded here. Each flow gets a one-time `state` bound to the member and server.

export interface OAuthProvider {
  id: string;
  slug: string;
  name: string;
  authorize_url: string;
  token_url: string;
  scopes: string;
  scope_param: string; // "scope" or "user_scope" (Slack)
  pkce: boolean;
  token_path: string; // where the member token sits in the response, e.g. "access_token" or "authed_user.access_token"
  client_id: string;
  client_secret_enc: string | null;
}

interface PendingFlow {
  userId: string;
  serverId: string;
  providerSlug: string;
  verifier: string;
}

const FLOW_TTL_MS = 10 * 60 * 1000;

export async function loadProvider(slug: string): Promise<OAuthProvider | null> {
  const { rows } = await pool.query<OAuthProvider>(`SELECT * FROM oauth_providers WHERE slug = $1`, [slug]);
  return rows[0] ?? null;
}

export async function loadProviderById(id: string): Promise<OAuthProvider | null> {
  const { rows } = await pool.query<OAuthProvider>(`SELECT * FROM oauth_providers WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export function providerReady(p: OAuthProvider): boolean {
  return Boolean(p.client_id && p.client_secret_enc);
}

function redirectUri(slug: string): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/api/oauth/${slug}/callback`;
}

export async function startFlow(p: OAuthProvider, userId: string, serverId: string): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + FLOW_TTL_MS);
  const stateHash = createHash("sha256").update(state).digest("hex");
  await pool.query(
    `INSERT INTO upstream_oauth_flows (state_hash, user_id, server_id, provider_slug, verifier_enc, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [stateHash, userId, serverId, p.slug, encrypt(verifier), expiresAt],
  );

  const url = new URL(p.authorize_url);
  url.searchParams.set("client_id", p.client_id);
  url.searchParams.set("redirect_uri", redirectUri(p.slug));
  url.searchParams.set(p.scope_param || "scope", p.scopes);
  url.searchParams.set("state", state);
  if (p.pkce) {
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

// Returns the flow the state belongs to, and consumes it (single use).
export async function finishFlow(providerSlug: string, state: string): Promise<PendingFlow | null> {
  const stateHash = createHash("sha256").update(state).digest("hex");
  const { rows } = await pool.query<{ user_id: string; server_id: string; provider_slug: string; verifier_enc: string }>(
    `DELETE FROM upstream_oauth_flows
      WHERE state_hash = $1 AND provider_slug = $2 AND expires_at > now()
      RETURNING user_id, server_id, provider_slug, verifier_enc`,
    [stateHash, providerSlug],
  );
  const flow = rows[0];
  if (!flow) {
    // Also discard expired or mismatched state, if any, so it cannot accumulate.
    await pool.query(`DELETE FROM upstream_oauth_flows WHERE state_hash = $1`, [stateHash]);
    return null;
  }
  return {
    userId: flow.user_id,
    serverId: flow.server_id,
    providerSlug: flow.provider_slug,
    verifier: decrypt(flow.verifier_enc),
  };
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export async function exchangeCode(p: OAuthProvider, code: string, verifier: string): Promise<{ accessToken: string; scope: string }> {
  if (!p.client_secret_enc) throw new Error("Provider has no client secret");
  const body = new URLSearchParams({
    client_id: p.client_id,
    client_secret: decrypt(p.client_secret_enc),
    code,
    redirect_uri: redirectUri(p.slug),
  });
  if (p.pkce) body.set("code_verifier", verifier);
  const res = await fetch(p.token_url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json()) as Record<string, unknown>;
  const accessToken = getPath(data, p.token_path || "access_token");
  const failed = data.ok === false || Boolean(data.error) || Boolean(data.error_description);
  if (!res.ok || failed || typeof accessToken !== "string" || !accessToken) {
    throw new Error(String(data.error_description ?? data.error ?? `Token exchange failed (${res.status})`));
  }
  return { accessToken, scope: String(getPath(data, "scope") ?? getPath(data, "authed_user.scope") ?? "") };
}
