# System design and tradeoffs

This document describes the system implemented in this repository and how it is deployed today. It separates implemented behavior from future scaling options.

## Components and technology

| Component | Technology | Responsibility |
|---|---|---|
| Dashboard | React 19, TypeScript, Vite, Tailwind CSS; unprivileged nginx container | Browser UI for members and administrators; static files only, API calls go to the gateway |
| Gateway | Node.js 22, TypeScript, Fastify, MCP SDK | Browser/API auth, MCP client aggregation, authorization, chat orchestration, upstream management, audit, and metrics |
| Gateway database | PostgreSQL 16 | Members, roles, sessions, API keys (hashes), OAuth records, server configuration, encrypted credentials, chat state, and audit data |
| WooCommerce MCP | Node.js 22, TypeScript, MCP Streamable HTTP | Exposes selected WooCommerce operations to the gateway; accesses WooCommerce using signed REST calls |
| Store | WordPress 7 with WooCommerce, MariaDB 11.4 | Demo storefront, catalog, accounts, and orders |
| Ingress | ingress-nginx | Host/path routing; terminates TLS in the production-like deployment |
| Cluster packaging | Helm, Kind locally, k3s on AWS; Argo CD for production-like GitOps | Installs and reconciles the same chart set with environment values |

The full Helm release places the charts in the `kube-mcp` namespace. The alternate `yamls/` deployment uses multiple namespaces and is maintained separately; it is not the layout produced by `scripts/init.sh`.

## Main request flows

### Browser

1. Browser loads the static React app from the dashboard Service through ingress-nginx.
2. The app calls same-origin `/api` routes through the same ingress host.
3. The gateway validates the session cookie, checks permissions on the server, reads or writes PostgreSQL, and returns the response.

Dashboard sessions use HttpOnly, SameSite cookies. Password sign-in is built in; Google sign-in is optional and uses a public OAuth client ID. Dashboard access does not use MCP API keys.

### MCP client tool call

1. Client sends a Streamable HTTP MCP request to `/mcp` with a member API key or an OAuth access token.
2. Gateway resolves the identity and current authorization from PostgreSQL. Permissions are not frozen in an API key.
3. Gateway maps the prefixed tool name (for example `woocommerce__list_products`) to its configured upstream.
4. It checks global tool rules, role capabilities, server grants, and per-member tool rules before forwarding the call.
5. It sends only the upstream's shared credential or the member's own OAuth token. The gateway credential is never forwarded upstream.
6. For WooCommerce, `woo-mcp` signs a REST request to WordPress, which reads or updates MariaDB.
7. Gateway returns the result and records the outcome, duration, user, server, and tool in the audit log.

### Dashboard chat

Chat requests use the signed-in member identity. The gateway asks the configured OpenAI-compatible or Anthropic model to select from tools the member can use. Tool calls run through the same authorization and audit path as external MCP calls. The agent has a bounded tool loop and limits returned tool text.

## Identity and authorization layers

- **Roles** bundle named permissions such as `servers.manage`, `members.manage`, `chat.use`, and `mcp.use`.
- **Server grants** give a member no access, read access, or read/write access to a server.
- **Tool rules** allow or deny a specific tool for a member. Explicit deny takes precedence; an explicit allow can permit a tool outside the ordinary server-level grant, so administrators should use it carefully.
- **Global tool rules** can block a tool for everyone.

The gateway enforces access on each request. Dashboard navigation and controls are hidden where possible, but UI hiding is not the security boundary. The permission registry is in `services/gateway/src/permissions.ts`; the decision logic is in `services/gateway/src/access.ts`.

MCP client authentication is separate from browser sign-in:

- API keys are generated randomly, shown once, stored as SHA-256 hashes, and revocable.
- The gateway's MCP OAuth server supports browser authorization with PKCE and rotating refresh tokens.
- Dashboard passwords use scrypt; browser sessions are persisted in PostgreSQL.
- Upstream OAuth access tokens and shared upstream credentials are encrypted with AES-256-GCM using a key in `gateway-secrets`.

See [Threat model](THREAT-MODEL.md) for known security gaps, including credential-key co-location and delegated permission escalation.

## Runtime and state boundaries

| Workload | State | Current deployment shape |
|---|---|---|
| Dashboard | Static assets in the image; browser state in the client | 1 replica by default; safe to add replicas behind its Service |
| Gateway | Request handlers are stateless; durable app data, rate-limit buckets, and short-lived OAuth flow state in PostgreSQL; upstream connection/health caches remain process-local | 2 replicas in dev/prod values (chart default 1) |
| `woo-mcp` | Request-oriented service; WooCommerce data stays in WordPress | 1 replica by default; can be replicated if the store can handle the added request load |
| PostgreSQL | Durable gateway state on a PVC | One StatefulSet pod and one `ReadWriteOnce` PVC; no HA/failover configuration |
| WordPress | Files, plugins, uploads on a PVC; store database in MariaDB | One replica with `Recreate` strategy and `ReadWriteOnce` storage |
| MariaDB | Durable WooCommerce data on a PVC | One StatefulSet pod and one `ReadWriteOnce` PVC; no replication/failover configured |
| Store setup Job | Idempotent initialization work | Runs as a Helm post-install/post-upgrade hook and exits on success |

Gateway schema initialization uses a PostgreSQL advisory lock to prevent concurrent migration runs. An application rollback does not automatically roll back database schema or restore data; take backups before upgrades that change persistence behavior.

## Failure behavior and observability

- Gateway readiness uses `/readyz`; liveness uses `/healthz`. Dashboard and `woo-mcp` expose `/healthz` readiness/liveness endpoints.
- Gateway periodically checks enabled upstream tool lists. An unavailable upstream is marked unreachable without taking down other integrations.
- Upstream list and call operations have timeouts. A failing upstream affects its calls, not the entire gateway process.
- `/mcp` has a default per-member request limit of 120 requests/minute. Failed-login and MCP rate-limit buckets are stored in PostgreSQL and shared across gateway replicas; bucket keys are hashed and stale rows are periodically pruned.
- Upstream OAuth state is persisted briefly in PostgreSQL; its PKCE verifier is encrypted and the state is consumed once. This lets the callback complete on any ready gateway replica.
- Database connections are pooled per replica (`DATABASE_POOL_MAX`, default 10). Total possible gateway connections are approximately replica count × pool maximum, before other clients.
- When a member's visible tool list exceeds `TOOL_DISCOVERY_THRESHOLD` (default 30), the gateway can expose `kmcp__search_tools` and `kmcp__call_tool` instead of the full list.
- Gateway `/metrics` returns Prometheus text metrics on port 8080. It is deliberately not routed by the public Ingress; scrape it from inside the cluster or through an explicitly secured monitoring path.
- Use Kubernetes events, pod logs, readiness, and the dashboard audit page together. The audit log explains tool outcomes; metrics aggregate service behavior.

## Deployment paths

### Local development

`scripts/init.sh` creates Kind using `infra/kind/kind.yaml`, builds the three application images locally, imports them into the Kind node, and installs `charts/stack` with `values-dev.yaml`. Default Kind networking uses kindnet and does not enforce NetworkPolicy. An optional Calico Kind config and pinned manifest are provided for policy testing; see [Setup](SETUP.md).

### Production-like deployment

`infra/aws/k3s` provisions two EC2 instances, a security group, and an Elastic IP. k3s installation is a separate operator step. `scripts/bootstrap.sh` creates Secrets, installs Argo CD, and applies the root app. Argo CD watches `gitops/apps`; the kube-mcp application deploys `charts/stack` with `values-prod.yaml`. GitHub Actions build and publish application images and update the production references.

Dev and prod values request two gateway replicas. The chart spreads them across node hostnames when possible and creates a PDB requiring one available gateway pod for voluntary disruption. These files provide a small self-managed deployment pattern, not an HA production platform: PostgreSQL remains a single instance and a gateway outage still occurs if its database is unavailable. Storage, backups, monitoring, TLS, secrets management, and resource sizing need to be reviewed for each real environment.

## Key design decisions and tradeoffs

| Decision | Benefit | Cost or limit |
|---|---|---|
| One gateway endpoint with per-call authorization | Central policy, audit, and client configuration | Gateway and PostgreSQL are critical dependencies |
| Separate browser sessions and MCP keys | Credentials fit their clients; keys do not grant dashboard sessions | Users manage two sign-in methods |
| Check authorization on every request | Role and grant changes take effect immediately | Each operation needs database-backed identity/permission checks |
| Prefix tool names with server slug | Simple flat tool list and routing | Renaming a server changes client-visible tool names |
| Store upstream secrets encrypted in PostgreSQL | Dashboard does not reveal credentials; DB-only read is less useful | Encryption key is stored in the same cluster Secret boundary |
| WooCommerce REST API from a separate service | No `kubectl exec` access to WordPress; narrow service path | Requires WooCommerce REST credentials and OAuth 1.0a signing |
| Single-instance databases and local PVCs | Simple local and small-cluster operations | No database HA; node loss can mean downtime or data loss |
| PostgreSQL-backed shared limits and OAuth flows | Behavior is consistent across gateway replicas | Adds database writes to rate-limited requests; PostgreSQL becomes more important as gateway traffic grows |
| Argo CD reconciles production config from Git | Deployments are reviewable and repeatable | A Git change can trigger rollout; protect branches and workflow credentials |

For capacity guidance and safe replica changes, see [Operations and scaling](OPERATIONS-AND-SCALING.md). Network boundaries and policy enforcement details are in [Networking](NETWORKING.md).
