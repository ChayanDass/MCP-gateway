# kube-mcp

A team MCP gateway on Kubernetes. Admins connect MCP servers once. Every team member then reaches all of them through one endpoint, and through a chat agent in the dashboard. The first data source is a WooCommerce store.

It runs in two places with the same Helm charts:

- **Local:** a Kind cluster on your machine, for development.
- **Production-like:** a k3s cluster on two AWS EC2 instances, with HTTPS and GitOps through Argo CD.

Browse the codebase on DeepWiki: [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ChayanDass/MCP-gateway)

## Contents

1. [What is in the repo](#what-is-in-the-repo)
2. [How the system fits together](#how-the-system-fits-together)
3. [Network and addresses](#network-and-addresses)
4. [Passwords and secrets](#passwords-and-secrets)
5. [Sign-in flows](#sign-in-flows)
6. [Run it locally](#run-it-locally)
7. [Run it on AWS](#run-it-on-aws)
8. [Use it](#use-it)
9. [Connect an external MCP client](#connect-an-external-mcp-client)
10. [Add and manage MCP servers](#add-and-manage-mcp-servers)
11. [Permissions, keys and audit](#permissions-keys-and-audit)
12. [Upgrades and rollback](#upgrades-and-rollback)
13. [Troubleshooting](#troubleshooting)
14. [More documentation](#more-documentation)

## What is in the repo

| Path | What it is |
|---|---|
| `charts/stack` | The whole stack as one Helm chart: ingress controller, store, MCP server, gateway, dashboard and ingress rules. Dev and prod values |
| `charts/store` | WordPress, WooCommerce, MariaDB, and the setup Job that configures the store |
| `charts/mcp` | The WooCommerce MCP server (`woo-mcp`) |
| `charts/gateway` | The gateway, the dashboard and the gateway's Postgres |
| `charts/ingress` | Ingress rules for the store and dashboard hostnames |
| `services/woo-mcp` | The WooCommerce MCP server: Node, Streamable HTTP, five tools |
| `services/gateway` | The gateway: MCP aggregation, routing, permissions, audit, chat agent, OAuth |
| `dashboard` | The React dashboard |
| `infra/kind` | Kind cluster configuration |
| `infra/aws/k3s` | Terraform for the two EC2 instances running k3s |
| `infra/aws/argocd` | Argo CD settings |
| `gitops` | Argo CD applications: the root app, cert-manager, the ClusterIssuer and the stack |
| `scripts/init.sh` | One-command local setup |
| `scripts/bootstrap.sh` | One-time setup for a GitOps cluster: secrets, certificate, Argo CD |
| `docs/` | Setup guide, store setup steps, roadmap |
| `.github/workflows` | CI: tests, image builds, chart publishing |

## How the system fits together

```
Browser / MCP client / chat agent
        |
        v
  Ingress (ingress-nginx)  ---- /api, /mcp, /oauth, /.well-known ---->  Gateway
        |                                                                  |
        | dashboard and store hostnames                                    | MCP client to each upstream
        v                                                                  v
  Dashboard (static)                          WooCommerce MCP  --->  WordPress (REST API) --> MariaDB
  WordPress (store)                           GitHub, Slack, docs servers (hosted, over HTTPS)
```

- **The store** is WordPress with WooCommerce. It keeps its data in MariaDB and its files in a persistent volume.
- **The WooCommerce MCP server** is the only component that talks to the store's REST API. It is reachable only from the gateway.
- **The gateway** is the single MCP endpoint. It connects to every enabled upstream server, lists their tools with a `server__tool` name, routes each call to the right server, enforces permissions, and writes the audit log. It also serves the dashboard API and runs the chat agent.
- **The dashboard** is a React app. It manages servers, members, keys, permissions, providers and the model, and shows the audit log.
- **The chat agent** runs in the gateway. It calls tools as the logged-in user, so its calls are audited under that user.

## Network and addresses

### Local (Kind)

| Address | What it reaches |
|---|---|
| `http://store.localtest.me` | The store, on port 80 of your machine |
| `http://localhost` | The dashboard and the gateway API, on port 80 |
| `http://kube-mcp.localtest.me` | The same dashboard |

`*.localtest.me` is a public name that resolves to `127.0.0.1`, so no `/etc/hosts` changes are needed. The Kind cluster maps host port 80 into the ingress controller.

### AWS (k3s, two EC2 instances)

| Address | What it reaches |
|---|---|
| `https://store.13.200.126.173.nip.io` | The store, with a Let's Encrypt certificate |
| `https://kube-mcp.13.200.126.173.nip.io` | The dashboard and gateway, with a Let's Encrypt certificate |
| `https://13.200.126.173` | The store, with a self-signed certificate (browsers warn) |

`nip.io` names point at the server's IP without owning a domain. To use your own domain later, change the hostnames in `charts/stack/values-prod.yaml` and point DNS at the server.

The server has an Elastic IP, `13.200.126.173`. The worker's public address can change, and nothing depends on it.

**Firewall (AWS security group):**
- Port 22 (SSH) and port 6443 (Kubernetes API): only from your IP.
- Ports 80 and 443 (web): open to everyone.
- Ports 6443, 8472 (VXLAN) and 10250 (kubelet): only between the two nodes.

**Inside the cluster:** every component has a NetworkPolicy:
- The gateway and dashboard accept traffic only from the ingress controller.
- The WooCommerce MCP server accepts traffic only from the gateway.
- The gateway's Postgres accepts traffic only from the gateway.
- MariaDB accepts traffic only from WordPress and the setup job.
- WordPress accepts traffic only from the ingress controller and the WooCommerce MCP server.

**Argo CD:** it has no public address. Reach it with a port-forward (see [Run it on AWS](#run-it-on-aws)).

## Passwords and secrets

Nothing secret is in git. Passwords are generated once and stored in Kubernetes Secrets. Helm, the bootstrap script and Argo CD never regenerate them, so the databases keep working across upgrades.

| What | Where it is stored | How to read it |
|---|---|---|
| Store admin (WordPress `admin`) | Secret `store-secrets`, key `wp-admin-password` | `kubectl -n kube-mcp get secret store-secrets -o jsonpath='{.data.wp-admin-password}' \| base64 -d; echo` |
| Dashboard and gateway admin (`admin@example.com`) | Secret `gateway-secrets`, key `bootstrap-admin-password` | `kubectl -n kube-mcp get secret gateway-secrets -o jsonpath='{.data.bootstrap-admin-password}' \| base64 -d; echo` |
| Argo CD admin (`admin`) | Secret `argocd-initial-admin-secret` | `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' \| base64 -d; echo` |
| WooCommerce REST key for woo-mcp | Secret `woo-mcp-credentials` | Created by the bootstrap script; the store setup job registers it |
| Gateway encryption key | Secret `gateway-secrets`, key `gateway-encryption-key` | Never print it. Losing it makes stored upstream credentials unreadable |
| Database passwords | Secrets `store-secrets` and `gateway-secrets` | Used by the apps; not needed by people |
| Stored upstream credentials (GitHub, Slack, OpenRouter) | The gateway's Postgres, encrypted with the encryption key | Entered in the dashboard; never shown again |
| Google OAuth client ID | `charts/stack/values-prod.yaml` (or `values-secrets.yaml` locally) | It is public, so it can be in git |

**Changing a password:**
- The dashboard admin password: sign in and change it in the app. The Secret keeps the install-time value, so it then only records the original.
- The store admin password: change it in WordPress (**Users → Profile**).

**Local files that are git-ignored, never commit them:** `charts/stack/values-secrets.yaml`, `.env`, and anything under `~/.config`.

## Sign-in flows

### Dashboard sign-in

1. **Password:** `admin@example.com` plus the dashboard admin password (see above). Failed sign-ins are rate limited: 10 failures in 15 minutes.
2. **Google:** the Google button uses your Google account. The gateway verifies Google's signed token against Google's public keys, and checks the client ID, the issuer, the expiry, and that the email is verified. If `GOOGLE_ALLOWED_DOMAINS` is set, only those domains can sign in. No Google secret is used.

For Google sign-in to work, the OAuth client in Google Cloud Console must list the dashboard address under **Authorized JavaScript origins**: `http://localhost` locally, or `https://kube-mcp.13.200.126.173.nip.io` on AWS.

### MCP clients

Clients sign in in one of two ways:

- **API key:** create a key for your account in the dashboard under **Clients**. Send it as `Authorization: Bearer <key>`. Keys are stored hashed and can be revoked at any time.
- **Browser sign-in (OAuth):** clients that support the MCP authorization flow register themselves, then open a browser for you to sign in. The gateway's OAuth server issues short-lived access tokens and longer-lived refresh tokens.

### Upstream sign-in (GitHub, Slack and other OAuth servers)

An admin sets up the provider once. Then each member connects with their own account:

1. Create the OAuth app in the provider (GitHub, Slack and so on). Its callback URL is `<dashboard address>/api/oauth/<slug>/callback`, for example `https://kube-mcp.13.200.126.173.nip.io/api/oauth/github/callback`.
2. In the dashboard, go to **Settings → Sign-in providers** and enter the provider's authorize URL, token URL, scopes, client ID and client secret. Slack needs the scope parameter `user_scope` and the token path `authed_user.access_token`. GitHub uses `scope` and `access_token`.
3. Add the server under **MCP servers**, with **Browser sign-in** and that provider.
4. Each member opens the server and clicks **Connect**. Their token is stored encrypted, and used only for their own calls.

If a connection shows *Reconnect*, the provider's token has expired or was revoked. Connect again.

## Run it locally

Prerequisites: Docker, `kind`, `kubectl`, and `helm` 3. Ports 80 and 8443 must be free.

```sh
./scripts/init.sh
```

The script creates the Kind cluster, asks for the Google client ID, installs the stack with one Helm command, waits for the store setup, and prints the addresses.

Then open:
- Store: `http://store.localtest.me`
- Dashboard: `http://localhost`, signing in as `admin@example.com`

The manual steps and the full local guide are in [docs/SETUP.md](docs/SETUP.md).

## Run it on AWS

### One-time setup

1. **Create the two EC2 instances** with Terraform from `infra/aws/k3s`. Pass your public IP, so SSH and the API accept only your address:
   ```sh
   cd infra/aws/k3s
   terraform init
   terraform apply -var "admin_cidr=$(curl -s https://checkip.amazonaws.com)/32"
   ```
2. **Install k3s** on the server and the worker, pinned to a version so the download comes from GitHub. Join the worker with the server's private address and the node token. The steps are in `docs/SETUP.md`.
3. **Point kubectl at the cluster** from your machine:
   ```sh
   export KUBECONFIG=~/.kube/kube-mcp-aws.yaml
   kubectl get nodes
   ```
4. **Bootstrap the cluster** once. This creates the secrets and the IP certificate, installs Argo CD, and applies the root app:
   ```sh
   PUBLIC_IP=13.200.126.173 ./scripts/bootstrap.sh
   ```

### Ongoing: GitOps

After bootstrap, the cluster follows GitHub. Argo CD watches `gitops/apps` and deploys in order:
- **Wave 0:** cert-manager.
- **Wave 1:** the Let's Encrypt ClusterIssuer.
- **Wave 2:** the stack, from `charts/stack` with `values-prod.yaml`.

To deploy a change, commit and push to `main`. The image workflow builds any changed service and commits its new image tag, and Argo CD rolls it out. Check it in the Argo CD UI, or with `kubectl -n argocd get applications`.

To open the Argo CD UI:
```sh
kubectl -n argocd port-forward svc/argocd-server 9090:443
```
Then open `https://localhost:9090` and sign in as `admin`, with the Argo CD password from the table above. Port 9090 is used because 8081 may already be taken on your machine.

### What runs where

- **Server node:** the control plane, the ingress controller (ports 80 and 443), and most workloads.
- **Worker node:** workloads only.

Each node has 2 GB of memory plus 2 GB of swap. If pods show `Pending` or restart, check `kubectl top nodes`.

## Use it

### Place an order on the storefront

1. Open the store and add a product to the cart.
2. Check out with **Cash on delivery**, the test payment method.
3. The order appears under **WooCommerce → Orders** in `wp-admin`, and through the gateway's `list_orders` tool.

Customers can register and set their own password on **My account**. No email is sent, because the cluster has no mail server.

### Use the chat agent

1. Sign in to the dashboard and open **Chat**, or use the **Ask** button at the bottom right.
2. Ask in plain language, for example "list today's orders" or "create a product called Blue Mug for 12.50".
3. The agent shows each tool call it makes. Each call is recorded in the audit log under your account.

The chat model is set in **Settings → Model**. It can be any OpenAI-compatible or Anthropic model, including free OpenRouter models. Models that support tools work best.

### Use the dashboard

- **Overview:** server health, recent calls and errors.
- **MCP servers:** a card per server, with its status and tool count. Open a server to see its tools and settings.
- **Clients:** your gateway address and key, with copy buttons and a config snippet for each client.
- **Security:** members, per-member tool permissions, and the audit log.
- **Settings:** sign-in providers and the chat model.
- **Theme:** the sidebar switch cycles light, dark and system. Your choice is saved in the browser.

## Connect an external MCP client

The gateway's MCP address is `<dashboard address>/mcp`:
- Local: `http://localhost/mcp`
- AWS: `https://kube-mcp.13.200.126.173.nip.io/mcp`

Add it to your client with your key as a Bearer token. For example, in Claude Code:

```sh
claude mcp add --transport http kube-mcp https://kube-mcp.13.200.126.173.nip.io/mcp \
  --header "Authorization: Bearer <your key>"
```

The client sees every tool your account may call. Tools you can't use are left out of the list.

## Add and manage MCP servers

In the dashboard, go to **MCP servers → Add MCP server**, and enter a name, a slug, and the URL of a Streamable HTTP server. Choose either:
- **Shared:** an optional header or bearer credential, used by the gateway for everyone.
- **Browser sign-in:** each member connects with their own account. See [Upstream sign-in](#upstream-sign-in-github-slack-and-other-oauth-servers).

You can edit, disable or remove a server. Disabling it removes its tools from the chat and from clients straight away.

Tool names are prefixed with the server's slug, for example `woocommerce__list_products` and `github__list_issues`. Two servers can each have a tool with the same name without clashing.

A server that can't be reached shows as *Unreachable*. The other servers keep working.

The servers set up now are WooCommerce, GitHub and Slack (per-member sign-in), and Context7 and DeepWiki (public, no key).

## Permissions, keys and audit

- **Roles:** an admin manages servers, members and settings. A member uses the tools they have been given.
- **Server access:** each member gets *none*, *read* or *write* for each server. For WooCommerce, read covers listing products and orders, and write adds product creation and order status changes.
- **Per-tool rules:** an admin can allow or deny individual tools for one member. Deny always wins.
- **Keys:** each member has their own API keys. A key can be revoked at any time, and the next call is rejected.
- **Audit log:** every tool call records the user, the server, the tool, the time, the duration and the outcome. Failed sign-ins and denied calls are recorded too.

The gateway never sends a member's key or the upstream credentials to upstream servers. Upstream calls use the server's own credential, or the member's own OAuth token for browser-sign-in servers.

## Upgrades and rollback

**Locally:**
```sh
helm upgrade kube-mcp charts/stack -n kube-mcp -f charts/stack/values-secrets.yaml -f charts/stack/values-dev.yaml
helm rollback kube-mcp <revision>
```

**On AWS:** change the chart or the code, commit to `main`, and let Argo CD roll it out. To roll back, revert the commit and push; Argo CD follows the revert.

Helm keeps the generated passwords, so an upgrade or rollback doesn't break the databases. Don't uninstall the release unless you want the data gone.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Store or dashboard unreachable locally | Kind not running, or port 80 in use | `kind get clusters`; free port 80 |
| Dashboard shows "Can't reach the gateway" | The gateway pod is restarting | Wait a minute, then *Try again* |
| WooCommerce tools say "Invalid signature" | woo-mcp signs with the wrong address | The signing address must be `http://` (see `charts/stack/values-prod.yaml`) |
| Google sign-in shows `origin_mismatch` | The dashboard address isn't in the OAuth client | Add it under *Authorized JavaScript origins* |
| A provider sign-in shows `redirect_uri_mismatch` | The callback URL in the provider doesn't match | Use `<dashboard address>/api/oauth/<slug>/callback` |
| A provider sign-in shows `insufficient scopes` | The provider has no scopes | Set the scopes in *Sign-in providers*, then reconnect |
| A server shows *Reconnect* | Its token expired or was revoked | Click *Connect* again |
| Argo CD shows `OutOfSync` or `Progressing` | A sync or a hook is still running | Wait; check `kubectl -n kube-mcp get pods` |
| Pods `Pending` on AWS | Not enough memory on the nodes | `kubectl top nodes`; reduce requests or add a node |
| Certificate stays not ready | Let's Encrypt can't reach port 80 | Check the security group and the ingress controller |
| Gateway restarts with `relation ... does not exist` | A database migration ran in the wrong order | Update the gateway image; the migration order is fixed in `db.ts` |

## More documentation

- [docs/SETUP.md](docs/SETUP.md): the detailed local setup, with the manual steps.
- [docs/STORE-SETUP.md](docs/STORE-SETUP.md): the WP-CLI steps that configure the store.
- [docs/NETWORKING.md](docs/NETWORKING.md): addresses, the ingress, certificates, `nip.io`, the firewall, and local versus AWS.
- [docs/SYSTEM-DESIGN-AND-TRADEOFFS.md](docs/SYSTEM-DESIGN-AND-TRADEOFFS.md): how the system is built, how a tool call travels, and why the main choices were made.
- [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md): assets, actors, controls, and the open gaps.
