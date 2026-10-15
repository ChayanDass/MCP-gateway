# Requirements status

Checked against the Urumi Round 1 brief ("MCP Gateway on Kubernetes").

Legend: **[x]** built and checked · **[~]** built, but partly checked or incomplete · **[ ]** not done

Dates: last checked 2026-10-15, against the local kind cluster `kube-mcp` and the code on `main`.

## Core: store

- [x] One WooCommerce store on Kubernetes (WordPress 7.0.4 + WooCommerce), in namespace `store`. Storefront checked: HTTP 200 at `store.localtest.me`.
- [x] Persistent storage: PVCs for MariaDB and WordPress (`yamls/store/02-mariadb.yaml`, `03-wordpress.yaml`).
- [~] Order flow: an order was placed on the storefront and read back through `get_order` and `list_orders`. The checkout itself and the WooCommerce admin view were not re-checked.
- [x] Setup Job installs WooCommerce, sample data and the MCP REST key (`yamls/store/04-setup.yaml`).

## Core: WooCommerce MCP server

- [x] Written by us, not an existing plugin or server (`services/woo-mcp`).
- [x] Streamable HTTP at `/mcp`.
- [x] Tools: `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status`. All five were called through the MCP endpoint.
- [x] Only reachable inside the cluster (`ClusterIP` Service). The network policy only admits the gateway's labels.
- [x] How it talks to the store is documented in the code: WooCommerce REST v3 with OAuth 1.0a signing (`services/woo-mcp/src/woo.ts`).
- [x] Network policies, default-deny per namespace, in `yamls/store/05-networkpolicies.yaml` and `yamls/Gateway/05-networkpolicies.yaml`. The woo-mcp pods are labelled `app.kubernetes.io/name: woo-mcp`, and the WordPress policy admits them by that label. Tested on Calico: five blocked paths from an unlabelled pod, and the allowed paths (gateway to woo-mcp and postgres, woo-mcp to WordPress, ingress to dashboard and gateway) still work. Not tested: the dashboard's own egress block.

## Core: gateway and dashboard

- [x] Admins add, edit, disable, and remove upstream servers, with an optional static header or bearer credential (dashboard `MCP servers` pages, `services/gateway/src/api.ts`).
- [x] One MCP endpoint, `/mcp`, that lists tools from every enabled server and routes each call to the right server. Gateway returns 401 without a key.
- [x] Tool name collisions are solved by prefixing each tool with its server slug, for example `woocommerce__list_products`. Documented in `README.md`.
- [x] Timeouts for list and call are configurable (`UPSTREAM_CALL_TIMEOUT_MS`, `UPSTREAM_LIST_TIMEOUT_MS`).
- [x] Upstream credentials are encrypted at rest with AES-256-GCM (`services/gateway/src/crypto.ts`) and stay on the server side.
- [~] Three upstreams: WooCommerce works. Slack is registered but fails with `invalid_token`. The README names GitHub, Slack, Context7 and DeepWiki, but only WooCommerce was checked in this session.
- [~] Dead upstream isolation: the code marks an upstream unreachable on failure, and other servers keep working. Not tested by killing a pod.
- [x] Dashboard UI rebuilt on shadcn/ui, with the server list, status, and tools per server.

## Team and access

- [x] Two roles, admin and member (`services/gateway/src/access.ts`, Members page).
- [x] Per-user API keys, stored as SHA-256 hashes (`services/gateway/src/identity.ts`).
- [~] Key revocation exists in the API and UI. Not tested: the revoked key being rejected on its next call.
- [x] Audit log page in the dashboard, with user, server, tool, duration, and outcome.
- [~] Audit entries for calls made through the gateway exist in code. Not checked against a live call from a second user.

## Chat agent

- [x] Chat page in the dashboard, with saved history and a visible list of tools called (`services/gateway/src/chat.ts`, `llm.ts`).
- [~] Built, but no model is configured in the cluster yet, so chat is disabled. Not tested end to end.
- [~] Acts as the logged-in user. Calls go through the gateway, so they are audited under that user. Not verified.

## Kubernetes and Helm

- [x] Runs on local Kind (`infra/kind/kind.yaml`, `kind-calico.yaml`).
- [x] Helm charts exist for store, mcp, gateway, ingress and stack (`charts/`).
- [x] Local and production differences are set through values files: `charts/stack/values.yaml` for local, `values-prod.yaml` for the VPS, `values-dev.yaml`.
- [~] Raw Kubernetes manifests also exist in `yamls/`. These are the versions used for the local cluster in this session. The brief says Helm is mandatory, so the Helm charts are the deliverable. Keep both, or drop `yamls/` before submitting.
- [x] Liveness and readiness probes on the workloads, and requests and limits (checked in the chart templates and `yamls/`).
- [x] Ingress with stable hosts (`localtest.me` locally, `nip.io` on the VPS). Documented in `README.md` and `docs/NETWORKING.md`.
- [x] Secrets live in Kubernetes Secrets. Passwords are generated on first install, and nothing is hardcoded in source (`charts/*/templates/secrets.yaml`).
- [~] Production VPS (k3s on AWS). Terraform and the prod values exist in `infra/aws/k3s` and `values-prod.yaml`. Not re-verified in this session.
- [~] Network policies exist for the store, MCP and gateway charts, and the store database only accepts WordPress and the setup Job. Not default-deny for the whole namespace.
- [x] Non-root containers, with `runAsNonRoot` in the dashboard and gateway templates.

## Security

- [x] SSRF protection for admin-added URLs: no loopback, link-local, or metadata hosts (`services/gateway/src/ssrf.ts`).
- [x] Tool permissions per member: allow, deny, or default per tool, with denied tools hidden or rejected (`ToolPermissionsPage`, `tool-access` API).
- [~] DNS rebinding is not defended against. The SSRF check looks only at the literal hostname, as its comment says.

## Standout options (pick what applies)

- [x] **Tool permissions** (option 2): see above.
- [x] **OAuth on the gateway** (option 3): MCP authorization with PKCE (S256) and rotating refresh tokens (`services/gateway/src/oauth-server.ts`). Not tested with a real MCP client in this session.
- [x] **Security hardening** (option 6): SSRF checks, encrypted credentials, non-root containers, network policies.
- [~] **Upgrades and rollback** (option 9): documented for Helm in `README.md`. The raw `yamls/` have no rollback notes.
- [~] **Production VPS** (option 1): see above.
- [ ] **Handling many tools** (option 4): not built.
- [ ] **Hosted MCP servers by container image** (option 5): not built.
- [ ] **Scaling** (option 7): `replicas` is a value in the gateway chart, but running more than one replica and checking sessions was not tested. Rate limits per user or key are not built. Login is throttled per IP (10 failures in 15 minutes).
- [~] **Observability** (option 8): audit log and per-upstream status are in place. No metrics such as error rate or latency per server.

## Bonus: multi-store provisioning

- [ ] Creating and deleting stores from the dashboard.
- [ ] Per-store namespace, database, Secrets, volumes and Ingress host.
- [ ] Automatic MCP registration per store.
- [ ] Clean teardown.
- [~] Per-namespace isolation exists in the store chart's network policies, but there is no per-store provisioning yet.
- [ ] ResourceQuota, LimitRange, per-user store limit, provisioning timeout.
- [ ] Retry-safe provisioning.

## Demo flow (definition of done)

- [~] Store checkout and order visible in WooCommerce admin. An order exists, placed by hand.
- [ ] Chat agent, as user A: creates a product. Chat is not configured yet.
- [ ] Chat agent, as user A: lists today's orders. Chat is not configured yet.
- [ ] External MCP client, as user B, connected with URL and key. Not tested with a second user.
- [ ] One prompt that uses tools from two different upstreams.
- [ ] Revoking user B's key makes the next call fail.
- [ ] Disabling one upstream removes its tools from both the chat agent and the client.
- [ ] Killing one upstream pod: the others keep working, and the dashboard shows it unreachable.
- [ ] Every call above appears in the audit log under the right user.

## Deliverables

- [x] `README.md`: local setup, what is in the repo, network layout, secrets, sign-in flows, run locally, run on AWS, use it, connect a client, troubleshooting. The design and threat model notes are linked below.
- [x] Source code for the dashboard, the gateway, the WooCommerce MCP server, and the chat agent.
- [x] Helm charts and values files (local and production).
- [x] `System design and tradeoffs` note: `docs/SYSTEM-DESIGN-AND-TRADEOFFS.md`. Linked from `README.md`.
- [x] `Threat model` note: `docs/THREAT-MODEL.md`. Linked from `README.md`.
- [ ] Demo video (you record this).
- [ ] Repo pushed to GitHub. Commits are on local `main`; the push failed for lack of credentials.

## Open issues

1. Slack upstream returns `invalid_token`. Walk-through is in the last chat reply: create the Slack OAuth app, add the provider, and connect each account.
2. Chat agent needs a model: **Settings → Model**.
3. The demo flow needs a second user and a second key.
4. `GOOGLE_CLIENT_ID` is set in `yamls/Gateway/02-gateway.yaml` and `charts/stack/values-secrets.yaml`. The client ID is not a secret, but keep `values-secrets.yaml` out of git (it is ignored).
