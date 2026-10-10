import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";

// OAuth authorization-code flow with PKCE, for connecting a member's own account
// to an upstream such as GitHub. Each flow gets a one-time `state` bound to the
// member who started it; the callback only accepts a state it issued.

interface PendingFlow {
  userId: string;
  verifier: string;
  provider: "github";
  expiresAt: number;
}

const FLOW_TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, PendingFlow>();

const PROVIDERS = {
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: "repo read:user",
  },
} as const;

export function providerConfigured(provider: "github"): boolean {
  return provider === "github" && Boolean(config.githubOAuthClientId && config.githubOAuthClientSecret);
}

function redirectUri(provider: string): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/api/oauth/${provider}/callback`;
}

export function startFlow(provider: "github", userId: string): string {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);

  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  pending.set(state, { userId, verifier, provider, expiresAt: now + FLOW_TTL_MS });

  const url = new URL(PROVIDERS[provider].authorizeUrl);
  url.searchParams.set("client_id", config.githubOAuthClientId);
  url.searchParams.set("redirect_uri", redirectUri(provider));
  url.searchParams.set("scope", PROVIDERS[provider].scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// Returns the member the flow belongs to, and consumes the state (single use).
export function finishFlow(provider: "github", state: string): PendingFlow | null {
  const flow = pending.get(state);
  pending.delete(state);
  if (!flow || flow.provider !== provider || flow.expiresAt < Date.now()) return null;
  return flow;
}

export async function exchangeCode(provider: "github", code: string, verifier: string): Promise<{ accessToken: string; scope: string }> {
  const res = await fetch(PROVIDERS[provider].tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.githubOAuthClientId,
      client_secret: config.githubOAuthClientSecret,
      code,
      redirect_uri: redirectUri(provider),
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json()) as { access_token?: string; scope?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? `Token exchange failed (${res.status})`);
  }
  return { accessToken: data.access_token, scope: data.scope ?? "" };
}
