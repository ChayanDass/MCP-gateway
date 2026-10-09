// All configuration comes from environment variables. In the cluster these
// are populated from Kubernetes Secrets (secretKeyRef) and ConfigMaps, never
// from values committed to the repo.
const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
};

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required("DATABASE_URL"),
  // 32-byte key, base64. Encrypts upstream credentials at rest.
  encryptionKey: required("ENCRYPTION_KEY"),
  bootstrapAdminEmail: required("BOOTSTRAP_ADMIN_EMAIL"),
  bootstrapAdminPassword: required("BOOTSTRAP_ADMIN_PASSWORD"),
  // URL of the WooCommerce MCP server, registered as the first system server.
  wooMcpUrl: process.env.WOO_MCP_URL ?? "http://woo-mcp:8080/mcp",
  dashboardDir: process.env.DASHBOARD_DIR ?? "/app/dashboard",
  // Per-call timeout for an upstream tool call.
  upstreamCallTimeoutMs: Number(process.env.UPSTREAM_CALL_TIMEOUT_MS ?? 15000),
  // Timeout for connecting to / listing tools on an upstream.
  upstreamListTimeoutMs: Number(process.env.UPSTREAM_LIST_TIMEOUT_MS ?? 4000),
  // How often the background health loop re-lists each enabled upstream.
  healthIntervalMs: Number(process.env.HEALTH_INTERVAL_MS ?? 15000),
  // Extra hostnames allowed for upstreams beyond the default SSRF rules
  // (comma separated). Used for in-cluster services in production if needed.
  upstreamHostAllowlist: (process.env.UPSTREAM_HOST_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
