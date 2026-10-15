# System design and tradeoffs

This note describes how the system is built today, how a request moves through it, how it fails, and why the main choices were made. Each part points to the code that implements it.

## Components

| Component | Responsibility | Code |
|---|---|---|
| Store | WordPress 7.0.4, WooCommerce and MariaDB 11.4 in the `store` namespace | `charts/store`, `yamls/store` |
| woo-mcp | MCP server (Streamable HTTP) that exposes products and orders as tools. Only the gateway can reach it. | `services/woo-mcp` |
| Gateway | Accounts, roles, permissions, API keys, audit log, chat agent, OAuth server for MCP clients. It is also an MCP client to every upstream server. | `services/gateway` |
| Dashboard | React single-page app for admins and members. Static files from nginx; API calls go to the gateway. | `dashboard` |
| Postgres | Gateway state: users, roles, keys (hashed), sessions, server registry, encrypted upstream credentials, audit log | `charts/gateway`, `yamls/Gateway` |
| Ingress | Routes `/api`, `/mcp`, `/oauth` and `/.well-known` to the gateway, and everything else to the dashboard | `charts/ingress`, `yamls/Gateway/04-ingress.yaml` |

Two sign-in paths reach the gateway, and they are kept apart:
- **The dashboard** uses a session cookie: HttpOnly, SameSite=Strict, valid 12 hours. Members sign in with a password or Google. The dashboard never uses an API key.
- **MCP clients** (Claude Code, Cursor, and similar) use a bearer credential: either a member's API key (`kmcp_…`), or an OAuth access token from the browser login flow (PKCE, S256).

## Authorization model

Permissions are the unit of control, and roles bundle them. The list is in `services/gateway/src/permissions.ts`. The dashboard reads the same list from `GET /api/permissions`, so one entry adds a permission everywhere.

| Permission | Lets a user |
|---|---|
| `members.manage` | Create, edit, revoke and delete members, set their roles, server access and passwords |
| `roles.manage` | Create and edit roles |
| `tools.manage` | Set per-tool rules, for servers and for members |
| `servers.manage` | Add, edit, turn off and remove MCP servers |
| `providers.manage` | Configure sign-in providers for upstream OAuth servers |
| `model.manage` | Choose the chat model and provider |
| `servers.full_access` | Use every server and tool without per-server grants |
| `audit.view_all` | See every audit entry; otherwise only their own |
| `chat.use` | Use the dashboard chat agent |
| `mcp.use` | Create API keys and connect MCP clients |

Two roles are built in. **Admin** has every permission and cannot be edited or deleted. **Member** has `chat.use` and `mcp.use`, plus the server grants an admin gives them. Admins create custom roles on the Roles & permissions page.

A permission is checked in three places: each API route checks it before doing work (`currentUser(req, reply, "…")`), the dashboard hides pages the user can't use, and the MCP endpoint refuses a user without `mcp.use`. The server check is the one that matters; the dashboard only hides controls.

## How a tool call travels

1. An MCP client sends `tools/call` to `/mcp` with its bearer credential. The gateway resolves the credential to a user and their permissions. A revoked user or a revoked key fails here.
2. The gateway decides whether the call is allowed, and records why (`explainCall` in `access.ts`). The order is:
   1. the tool is blocked for everyone by an admin → denied;
   2. the role has `servers.full_access` → allowed;
   3. the member has no grant to the server → denied;
   4. the member has a per-tool deny → denied; a per-tool allow → allowed;
   5. a third-party server → allowed, since the server's own token limits it;
   6. a system server (WooCommerce) → read tools need a read grant, write tools need a read and write grant.
3. The gateway finds the upstream from the tool's prefix: `woocommerce__list_products` goes to the server with slug `woocommerce`.
4. It opens or reuses a Streamable HTTP connection with the upstream's own credential. For browser sign-in servers, the member's own upstream token is used, and only for their calls. The member's gateway credential is never forwarded.
5. woo-mcp calls WordPress's REST API, signed with OAuth 1.0a. WordPress reads MariaDB.
6. The result goes back through the gateway, and an audit row is written with user, server, tool, duration and outcome.

The same decision function serves the tool-permissions page, so the page shows what the gateway enforces, with the reason.

## Naming, timeouts and failure handling

- **Tool names** are `<server slug>__<tool>`. Two servers can each have `list_items` without a clash, and the model sees which server a tool belongs to.
- **Health:** every 15 s (`HEALTH_INTERVAL_MS`) the gateway lists each enabled upstream. A failure marks it `unreachable` and keeps its error text. Other servers keep working.
- **Timeouts:** listing waits up to 15 s (`UPSTREAM_LIST_TIMEOUT_MS`), and each call up to 15 s (`UPSTREAM_CALL_TIMEOUT_MS`). A slow upstream returns a clear error to the caller only.
- **Connections** are cached per server and credential. A changed credential opens a new connection, and a dead one is dropped.
- **Chat** stops after 8 tool steps, and each tool result is cut to 3,000 characters, so a loop or a large result can't exhaust it.
- **Login** is throttled: 10 failed attempts per client address in 15 minutes.

## Kubernetes layout

The local cluster (`yamls/`) uses three namespaces. The AWS cluster (`charts/stack`) puts everything in one, `kube-mcp`.

| Workload | Namespace | Image | Port | Probes | Requests | Limits | Storage | Reached from |
|---|---|---|---|---|---|---|---|---|
| WordPress | store | `wordpress:7.0.4-php8.3-apache` | 80 | `/wp-login.php` (readiness and liveness) | 250m, 384Mi | 1 CPU, 768Mi | 5Gi PVC | Ingress, `store.localtest.me` |
| MariaDB | store | `mariadb:11.4` | 3306 | `mariadb-admin ping` | 100m, 256Mi | 500m, 768Mi | 5Gi PVC | WordPress and the setup Job only |
| Setup Job | store | `wordpress:cli-php8.3` | — | none (runs once) | 100m, 256Mi | 500m, 512Mi | shares the WordPress PVC | Nothing; it runs and exits |
| woo-mcp | store | `woo-mcp` | 8080 | `/healthz` | 50m, 64Mi | 300m, 192Mi | none | The gateway only |
| Postgres | gateway | `postgres:16-alpine` | 5432 | `pg_isready` | 250m, 256Mi | 500m, 512Mi | 2Gi PVC | The gateway only |
| Gateway | gateway | `gateway` | 8080 | `/healthz`, `/readyz` (readiness checks the database) | 100m, 128Mi | 200m, 256Mi | none | Ingress (`/api`, `/mcp`, `/oauth`, `/.well-known`) and the dashboard |
| Dashboard | gateway | `dashboard` (nginx, unprivileged) | 8080 | `/healthz` | 10m, 16Mi | 100m, 64Mi | none | Ingress (`/`) |
| Ingress controller | ingress-nginx | `ingress-nginx/controller` | 80, 443 | the controller's own | — | — | — | The internet, on the host ports |

**Secrets:** `store-secrets` (database and WordPress passwords) and `woo-mcp-credentials` (the WooCommerce key) in `store`; `gateway-secrets` (Postgres password, encryption key, bootstrap admin password) in `gateway`. Secrets are read as environment variables, and nothing secret is in a manifest.

**Security context:** the gateway, woo-mcp and the dashboard run as a non-root user, with privilege escalation off and all capabilities dropped. The gateway and woo-mcp images run as uid 1000; the dashboard image runs unprivileged. The store and database images keep their own users.

**Public and internal:** only the ingress controller is reachable from outside. Everything else is a `ClusterIP` service, and each one is limited by a NetworkPolicy (see [NETWORKING.md](NETWORKING.md), section 9).

**Migrations:** the gateway creates or changes its schema at startup, under a Postgres advisory lock, so two replicas can't migrate at once.

## Key decisions

**Dashboard on sessions, MCP on keys.** A browser can hold a cookie safely; a client config file cannot. Keeping them apart means a leaked key can't be used to reach the dashboard, and a session can't be copied into a client.

**Keys are created by the member, shown once, and stored as SHA-256 hashes.** Keys are 32 random bytes, so a salted slow hash would add cost without protection. Members revoke their own keys; admins cannot see or revoke other members' keys, only revoke their access. The earlier design, where the gateway kept an encrypted copy of each key so it could be shown again, was removed.

**Permissions live in roles, server access per member, and tool rules per member.** Roles answer "what kind of user is this?"; server grants answer "which servers?"; tool rules answer "which exact tools?". Each layer can only narrow the one above, except the explicit allow rule, which can widen a tool the server grant doesn't cover. That makes allow the one sharp edge, so the reason column names it.

**Permission checks happen on every request, not in the token.** A key or session carries no permissions. A change to a role or a member takes effect on the next call, with no re-issue. The cost is one database lookup per request.

**Prefixed tool names, not MCP namespaces.** The MCP spec has no namespaces, and clients show a flat list. A prefix is the simplest form that works everywhere, and it doubles as the routing key. The cost is that renaming a server renames its tools.

**Postgres for gateway state.** Users, roles, keys, sessions, the audit log and encrypted credentials need queries and transactions. Schema changes run at startup under an advisory lock, so two replicas can't migrate at once.

**WooCommerce REST API, not WP-CLI.** woo-mcp speaks HTTP only. It needs no `kubectl exec` into WordPress, so it can run in its own namespace with a narrow network policy, and it works the same locally and on AWS. The cost is OAuth 1.0a signing, which `woo.ts` implements.

**Network policies default-deny per namespace.** Each allowed path is one explicit rule (the store and gateway charts). The local cluster uses Calico, because kind's default CNI doesn't enforce policies.

**Stateless MCP endpoint.** Each request builds its own MCP server and transport, so any replica can answer and a restart loses no session. Upstream connections are per replica.

**GitOps for AWS.** Argo CD syncs `charts/stack` with `values-prod.yaml`, with automatic prune and self-heal. The image workflow builds only the images whose code changed, and then commits the new tags into the charts, so a deployment is a commit.

## Tradeoffs

| Choice | What we get | What it costs |
|---|---|---|
| Permissions checked per request | Changes apply immediately; no stale tokens | One database lookup per request |
| Sessions for the dashboard, keys for clients | Each credential fits its client | Two credential types to explain and to protect |
| Keys never expire | Clients keep working without a renewal step | A leaked key stays valid until someone revokes it |
| Hashes only, no recoverable key copy | A database leak doesn't reveal keys | A lost key can't be shown again; the member makes a new one |
| Single Postgres, single WordPress on a `ReadWriteOnce` volume | Simple, and correct for one store | WordPress uses `Recreate`, so each upgrade causes downtime; no HA |
| Health by re-listing tools every 15 s | Reports real capability | Detection can lag 15 s; a dead upstream costs one timeout per cycle |
| Tool descriptions passed to the model as-is | Clients see the real descriptions | An untrusted server can put instructions in them |
| Hostname-only SSRF check | Blocks loopback, metadata and private names | Doesn't stop DNS rebinding |
| Monogram logos | No third-party files fetched | Less recognisable than real logos |
| Raw manifests in `yamls/` next to the Helm charts | Easy to check each step locally | Two copies to keep in step; the charts are the deliverable |

## What changes for production

- **DNS and TLS:** `charts/stack/values-prod.yaml` sets the hostnames, and cert-manager issues Let's Encrypt certificates. Replace the `nip.io` names with a real domain, and set `PUBLIC_BASE_URL` to match. Google's authorized origins must match the HTTPS address.
- **Storage:** local-path volumes stay on one node. A multi-node cluster needs a networked storage class.
- **Secrets:** generated on first install. `charts/stack/values-secrets.yaml` is git-ignored. For a shared cluster, create the Secrets yourself and reference them.
- **Database:** the gateway migrates the schema on startup. Take a `pg_dump` before any upgrade that changes the schema.
- **Upgrades and rollback:** see the README section *Upgrades and rollback*. Argo CD rolls back by reverting the deploy commit.
