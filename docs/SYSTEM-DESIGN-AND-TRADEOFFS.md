# System design and tradeoffs

This note explains how the system is built, how a tool call travels through it, how failures are handled, and why the main choices were made. Every claim points to code or config in this repo.

## Components

| Component | What it does | Where |
|---|---|---|
| Store | WordPress 7.0.4 with WooCommerce and MariaDB 11.4, in namespace `store` | `charts/store`, `yamls/store` |
| WooCommerce MCP server | Exposes products and orders as MCP tools, over Streamable HTTP. Reachable only from the gateway. | `services/woo-mcp` |
| Gateway | MCP client to every registered server, and an MCP server to clients. Also holds users, keys, permissions, audit log and chat. | `services/gateway` |
| Dashboard | React single-page app for admins and members. Static files served by nginx, with API calls going to the gateway. | `dashboard` |
| Postgres | Gateway state: users, hashed keys, sessions, server registry, encrypted upstream credentials, audit log | `charts/gateway`, `yamls/Gateway` |
| Ingress | One host per address; `/api`, `/mcp`, `/oauth` and `/.well-known` go to the gateway, the rest to the dashboard | `charts/ingress`, `yamls/Gateway/04-ingress.yaml` |

## How a tool call travels

1. An MCP client (or the chat agent) sends `tools/call` to `/mcp` on the gateway. The request carries the member's gateway key or OAuth token.
2. The gateway authenticates the member and checks their per-tool rule (`services/gateway/src/tools.ts`). A denied call returns an error without contacting the upstream.
3. The gateway finds the server from the tool's prefix. A tool named `woocommerce__list_products` goes to the server with slug `woocommerce`.
4. The gateway opens (or reuses) a Streamable HTTP connection to that server, with the upstream's own credential attached (`upstreams.ts`, `connect`). The member never sees that credential.
5. The upstream runs the tool. For the store, woo-mcp calls WordPress over the WooCommerce REST API, signed with OAuth 1.0a.
6. The result comes back through the gateway. Its text is written to the audit log with user, server, tool, duration and outcome.

## Tool aggregation and naming

- **Listing:** the gateway lists the tools of every enabled server, in parallel, with a per-server list timeout (`UPSTREAM_LIST_TIMEOUT_MS`, 15 s by default). Each tool gets its server's name in the description, and is hidden if the member can't call it.
- **Names:** `<server slug>__<tool>`. This is deterministic, so two servers can each have `list_items` without a clash, and the model can see which server a tool belongs to.
- **Permissions:** each tool can be allowed, denied, or inherit the default. Deny wins. The list and the call both check the same rule, so a hidden tool can't be called directly.

## Failure handling

- **Health loop:** every 15 s (`HEALTH_INTERVAL_MS`), the gateway re-lists each enabled upstream. A failure marks it `unreachable`, with the error text, and keeps the other servers working (`upstreams.ts`).
- **Call timeouts:** each call has a hard timeout (`UPSTREAM_CALL_TIMEOUT_MS`, 15 s). A slow upstream returns a clear error to the caller, and doesn't block other servers.
- **Connection reuse:** clients are cached per server and per credential fingerprint. A changed credential opens a new connection, and a dead one is dropped.
- **Chat:** the agent stops after 8 tool steps and truncates each tool result to 3,000 characters, so a runaway model or a large result can't exhaust it.

## Key decisions and why

**MCP is stateless per request in the gateway.** Each `/mcp` request builds a fresh server and transport (`services/woo-mcp/src/index.ts` and `services/gateway/src/api.ts`). Any replica can answer, and a restart loses nothing. The cost is that the gateway, not the request, holds the upstream connections, so each replica opens its own.

**Prefixed tool names, not namespaces or MCP resources.** The MCP spec has no namespace concept, and clients show a flat list. A prefix is the simplest thing that works in every client, and it doubles as the routing key. The cost: a slug can't be renamed without changing tool names.

**Postgres for gateway state.** Users, keys, sessions, the audit log and encrypted credentials need transactions and queries (audit filters, revocation, per-tool rules). A file store or an in-memory map would not survive a restart or a second replica.

**API keys hashed with SHA-256, no salt.** Keys are 32 bytes of randomness, so a salted slow hash adds cost without adding protection against guessing. A leaked database still doesn't reveal the keys.

**Credentials encrypted with AES-256-GCM, key in a Kubernetes Secret.** The gateway's encryption key sits in the same cluster as the database, so encryption at rest protects against a database dump, not against someone who can read Secrets in the namespace. Moving the key to an external KMS is the next step (see the threat model).

**WooCommerce REST API instead of WP-CLI.** The MCP server talks HTTP only. It doesn't need `kubectl exec` into the WordPress pod, so it can run in its own namespace with a narrow network policy, and it works the same locally and on the VPS. The cost is OAuth 1.0a signing code, which `woo.ts` implements.

**Browser sign-in per member for third-party servers.** Slack and GitHub need each person's own token, so a shared credential would give everyone the same access. Each member connects once, and their token is used only for their own calls.

**Session cookies are HttpOnly and SameSite=Strict, valid 12 hours.** The dashboard never handles a token the page can read.

**OAuth for MCP clients uses PKCE (S256), 10-minute sign-in flows, and rotating refresh tokens valid 30 days.** Clients are public, so no client secret is needed.

**Network policies per namespace, default-deny ingress.** Each allowed path is an explicit rule. Calico enforces them. The default local CNI (kindnet) does not, so the local setup uses Calico (`infra/kind/kind-calico.yaml`).

**Raw manifests and Helm charts both exist.** The brief asks for Helm. The charts are the deliverable and drive the VPS deployment. The `yamls/` folder is the same design written as plain manifests for the local cluster, which made each step easier to check. Keep one of them before submitting.

## Tradeoffs we accepted

| Choice | Benefit | Cost |
|---|---|---|
| Single Postgres, single WordPress with a `ReadWriteOnce` volume | Simple, and correct for one store | WordPress uses `Recreate`, so each upgrade causes downtime; no HA |
| Gateway replicas share Postgres but each opens its own upstream connections | Stateless and easy to scale | Upstream connections are duplicated per replica |
| Per-request MCP server | No session state to lose | Each request pays for setup; long-lived streams are not optimized |
| Health checks by re-listing tools every 15 s | Simple, and it reports real capability | Detection can lag up to 15 s; a dead upstream costs one timeout per cycle |
| Tool descriptions passed to the model as-is | Clients see the real descriptions | An untrusted server can write instructions into them (see the threat model) |
| Hostname-only SSRF check | Blocks loopback, metadata and private names | Does not defend against DNS rebinding |
| `nip.io` and `localtest.me` hostnames | Work without DNS setup | Browsers need HTTPS on public names, and Google sign-in accepts plain HTTP only on `localhost` |
| Monogram logos instead of brand images | No third-party files fetched | Less recognisable than the real logos |

## What changes for production

- **DNS and TLS:** `charts/stack/values-prod.yaml` sets the hostnames, and cert-manager issues Let's Encrypt certificates for them. Replace the `nip.io` names with a real domain, and set `PUBLIC_BASE_URL` to match.
- **Storage class:** locally `standard` (local-path). On k3s the default class is also local-path, so the PVCs stay on one node. A VPS with a second node would need a networked storage class.
- **Secrets:** locally generated and stored in Kubernetes Secrets. For production, keep `values-secrets.yaml` out of git (it is ignored), and consider an external secret store.
- **Google sign-in:** the authorized origins in the Google console must match the public HTTPS address.
- **Upgrades and rollback:** `helm upgrade` and `helm rollback` (see README, *Upgrades and rollback*). Passwords are kept across upgrades by the chart's lookup logic.
