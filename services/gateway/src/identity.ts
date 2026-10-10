import type { IncomingMessage } from "node:http";
import { pool } from "./db.js";
import { newToken, sha256 } from "./crypto.js";

export interface Identity {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_COOKIE = "kmcp_session";

// Resolves a gateway API key (Bearer token) to a user. Looked up on every
// request, so revoking a key or disabling a user takes effect on the next call.
export async function identityFromApiKey(authHeader: string | undefined): Promise<Identity | null> {
  const match = authHeader?.match(/^Bearer\s+(kmcp_[A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const { rows } = await pool.query<Identity>(
    `SELECT u.id, u.email, u.name, u.role
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND NOT u.disabled`,
    [sha256(match[1])],
  );
  return rows[0] ?? null;
}

// Resolves a Bearer token to a member: a gateway API key (kmcp_) or an OAuth access
// token issued through browser login (kmcpa_).
export async function identityFromBearer(authHeader: string | undefined): Promise<Identity | null> {
  const match = authHeader?.match(/^Bearer\s+(kmcp[a]?_[A-Za-z0-9_-]+)$/);
  if (!match) return null;
  if (match[1].startsWith("kmcpa_")) {
    const { identityFromOAuthAccess } = await import("./oauth-server.js");
    return identityFromOAuthAccess(match[1]);
  }
  return identityFromApiKey(authHeader);
}

// Resolves the dashboard session cookie to a user.
export async function identityFromSession(req: IncomingMessage): Promise<Identity | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const { rows } = await pool.query<Identity>(
    `SELECT u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function createSession(userId: string): Promise<string> {
  const token = newToken("kses_");
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [
    sha256(token),
    userId,
    new Date(Date.now() + SESSION_TTL_MS),
  ]);
  return token;
}

export async function deleteSession(req: IncomingMessage): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
}

// Secure is set when the gateway is served over HTTPS (PUBLIC_BASE_URL).
export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
