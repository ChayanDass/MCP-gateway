import { notify } from "./toast";

// Thin fetch wrapper. The session lives in an HttpOnly cookie, so the
// browser never handles a token the page can read.
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    const error = new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
    // Every failed change shows a message, even on pages that don't show their own.
    // Sign-in failures and session checks report on their own, so they are skipped.
    if (method !== "GET" && res.status !== 401 && !path.startsWith("/api/auth/")) notify(error.message, "error");
    throw error;
  }
  return data as T;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

export interface ServerView {
  id: string;
  slug: string;
  name: string;
  url: string;
  enabled: boolean;
  chatEnabled: boolean;
  isSystem: boolean;
  hasCredential: boolean;
  authHeader: string | null;
  status: "connected" | "unreachable" | "disabled" | "unknown" | "not_connected" | "reconnect";
  authMode?: "static" | "oauth";
  providerId?: string | null;
  toolCount?: number;
  error: string | null;
  checkedAt: number;
  tools: { name: string; description: string; class: "read" | "write" | "blocked"; override: "auto" | "read" | "write" | "blocked" }[];
}

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  disabled: boolean;
  active_keys: string;
}

export interface KeyView {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  revoked_at: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  user_email: string;
  server_slug: string;
  tool: string;
  source: "mcp" | "chat";
  duration_ms: number;
  outcome: string;
  error: string | null;
}

export interface ChatReply {
  reply: string;
  toolCalls: { name: string; isError: boolean }[];
}
