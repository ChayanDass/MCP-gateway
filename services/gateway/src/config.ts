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
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleAllowedDomains: (process.env.GOOGLE_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  dashboardDir: process.env.DASHBOARD_DIR ?? "/app/dashboard",
  // Per-call timeout for an upstream tool call.
  upstreamCallTimeoutMs: Number(process.env.UPSTREAM_CALL_TIMEOUT_MS ?? 15000),
  // Timeout for connecting to / listing tools on an upstream.
  upstreamListTimeoutMs: Number(process.env.UPSTREAM_LIST_TIMEOUT_MS ?? 15000),
  // How often the background health loop re-lists each enabled upstream.
  healthIntervalMs: Number(process.env.HEALTH_INTERVAL_MS ?? 15000),
  // Stores (WooCommerce on the cluster, one namespace each).
  storeBaseDomain: process.env.STORE_BASE_DOMAIN ?? "localtest.me",
  storeScheme: process.env.STORE_URL_SCHEME ?? "http",
  storeStorageClass: process.env.STORE_STORAGE_CLASS ?? "standard",
  storeTlsIssuer: process.env.STORE_TLS_ISSUER ?? "",
  maxStoresPerUser: Number(process.env.MAX_STORES_PER_USER ?? 3),
  storeProvisionTimeoutMs: Number(process.env.STORE_PROVISION_TIMEOUT_MS ?? 1200000),
  storeImages: {
    wordpress: process.env.STORE_IMAGE_WORDPRESS ?? "wordpress:7.0.4-php8.3-apache",
    mariadb: process.env.STORE_IMAGE_MARIADB ?? "mariadb:11.4",
    wpCli: process.env.STORE_IMAGE_WPCLI ?? "wordpress:cli-php8.3",
    wooMcp: process.env.STORE_IMAGE_WOO_MCP ?? "woo-mcp:0.1.0",
  },
  // Calls per key (or per member, for session users) per minute on /mcp.
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120),
  // When one member can see more tools than this, /mcp offers two meta tools
  // (search and call) instead of the full list, so the model's context stays small.
  toolDiscoveryThreshold: Number(process.env.TOOL_DISCOVERY_THRESHOLD ?? 30),
  // Extra hostnames allowed for upstreams beyond the default SSRF rules
  // (comma separated). Used for in-cluster services in production if needed.
  upstreamHostAllowlist: (process.env.UPSTREAM_HOST_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
