# Setup guide: local Kubernetes (Kind)

The whole stack installs with one Helm command, from the chart in `charts/stack`:

```sh
helm install kube-mcp charts/stack -n kube-mcp --create-namespace -f charts/stack/values-secrets.yaml
```

Before that command you need a Kind cluster, the three MCP images loaded into it, and one secrets file. The steps below cover those.

## What gets installed

| Part | Source | Address |
|---|---|---|
| Ingress controller (ingress-nginx 4.15.1) | `charts/stack` dependency | ports 80 and 8443 on your machine |
| Store: WordPress, WooCommerce, MariaDB, setup Job | `charts/store` | http://store.localtest.me |
| WooCommerce MCP server (`woo-mcp`) | `charts/mcp` | in-cluster only |
| Gateway, dashboard, Postgres | `charts/gateway` | http://localhost |
| Ingress rules for the store and dashboard | `charts/ingress` | — |

Everything runs in the `kube-mcp` namespace. `*.localtest.me` resolves to `127.0.0.1`, so no `/etc/hosts` edits are needed.

## 1. Prerequisites

Install Docker, `kind`, `kubectl`, `helm` 3, and `git`. Check them:

```sh
docker version --format '{{.Server.Version}}'
kind version
kubectl version --client
helm version --short
```

Keep ports **80** and **8443** free on your machine.

## 2. Create the cluster

```sh
kind create cluster --config infra/kind/kind.yaml
```

This creates the node with the `ingress-ready=true` label, which the ingress controller needs. The config maps host port 80 into the cluster.

## 3. Load the MCP images

The store uses public images. The three MCP images come from this repository. The Kind node can't see images on your Docker daemon, so build them and load them:

```sh
docker build -t kube-mcp/woo-mcp:0.1.0 services/woo-mcp
docker build -t kube-mcp/gateway:0.1.0 services/gateway
docker build -t kube-mcp/dashboard:0.1.0 dashboard

for n in woo-mcp gateway dashboard; do
  docker save kube-mcp/$n:0.1.0 \
    | docker exec -i kube-mcp-control-plane ctr -n k8s.io images import --all-platforms -
done
```

If `ctr` prints `content digest ... not found`, ignore it. The image still loads.

The ingress controller image also has to be on the node. Pull it on your machine and load it the same way, because the node often can't reach `registry.k8s.io`:

```sh
docker pull registry.k8s.io/ingress-nginx/controller:v1.15.1
docker save registry.k8s.io/ingress-nginx/controller:v1.15.1 \
  | docker exec -i kube-mcp-control-plane ctr -n k8s.io images import --all-platforms -
```

## 4. Create the secrets file

The stack needs one value that is not in the repo: the Google OAuth client ID. The WooCommerce key is generated for you. Copy the example and fill it in:

```sh
cp charts/stack/values-secrets.example.yaml charts/stack/values-secrets.yaml
chmod 600 charts/stack/values-secrets.yaml
```

Edit `charts/stack/values-secrets.yaml`:

- **`gateway.auth.googleClientId`:** the client ID from Google Cloud Console.

`values-secrets.yaml` is git-ignored. Check with `git check-ignore -v charts/stack/values-secrets.yaml`.

## 5. Install the stack

```sh
helm install kube-mcp charts/stack -n kube-mcp --create-namespace \
  -f charts/stack/values-secrets.yaml
```

This is the only Helm command you need. It installs the ingress controller, the store, the WooCommerce MCP server, the gateway, the dashboard and the ingress rules, in one release.

Wait for the store's setup Job to finish. It installs WordPress and WooCommerce, the sample products, and the store settings:

```sh
kubectl -n kube-mcp wait --for=condition=complete job/store-setup --timeout=15m
kubectl -n kube-mcp get pods
```

Every pod should be `Running`, except the setup Job, which shows `Completed`.

In the Google Cloud Console, add `http://localhost` to the OAuth client's **Authorized JavaScript origins**.

## 6. WooCommerce key (automatic)

Nothing to do here. The chart generates the WooCommerce REST key into the `woo-mcp-credentials` Secret, and the setup Job registers it in WooCommerce. woo-mcp reads the Secret.

To check it:

```sh
kubectl -n kube-mcp get secret woo-mcp-credentials -o jsonpath='{.data.consumer-key}' | base64 -d | cut -c1-6; echo
kubectl -n kube-mcp rollout status deploy/woo-mcp
```

The first command prints the start of the key (`ck_...`). The second confirms woo-mcp is running.

## 7. Sign in and check

Open http://localhost and sign in:

- **Email:** `admin@example.com`
- **Password:**
  ```sh
  kubectl -n kube-mcp get secret gateway-secrets -o jsonpath='{.data.bootstrap-admin-password}' | base64 -d; echo
  ```

Check the endpoints:

```sh
curl -s -o /dev/null -w "dashboard       %{http_code}\n" http://localhost/
curl -s -o /dev/null -w "gateway health  %{http_code}\n" http://localhost/healthz
curl -s -o /dev/null -w "store           %{http_code}\n" http://store.localtest.me/shop/
```

Expected: `200` for all three.

To check the WooCommerce tools from inside the cluster, call `tools/list` on `woo-mcp` from the gateway pod. The output lists the five tools:

```sh
kubectl -n kube-mcp exec deploy/gateway -- node -e '
fetch("http://woo-mcp:8080/mcp", {method:"POST", headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},
 body: JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})})
 .then(r=>r.text()).then(t=>console.log(t.slice(0,200)))'
```

## Changing things later

Edit the values or the code, then run one of these:

```sh
# values or chart changes
helm upgrade kube-mcp charts/stack -n kube-mcp -f charts/stack/values-secrets.yaml

# after changing a service's source code: rebuild, load, and restart it
docker build -t kube-mcp/gateway:0.1.0 services/gateway
docker save kube-mcp/gateway:0.1.0 | docker exec -i kube-mcp-control-plane ctr -n k8s.io images import --all-platforms -
kubectl -n kube-mcp rollout restart deploy/gateway
```

Helm keeps the generated passwords and the encryption key on upgrade, so existing data stays readable.

## Removing everything

```sh
helm uninstall kube-mcp -n kube-mcp
kubectl delete namespace kube-mcp
kind delete cluster --name kube-mcp
docker rm -f kube-mcp-gateway-proxy
```

Deleting the namespace also deletes the data volumes, so the store and gateway data are gone.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `connection reset by peer` during a chart download | Network problem | Run the same command again |
| Controller pod stuck in `ImagePullBackOff` | Node can't reach `registry.k8s.io` | Load the controller image (step 3) |
| `x509: certificate signed by unknown authority` on ingress | Admission webhook certificate | Already disabled in `charts/stack/values.yaml` for local use |
| woo-mcp stuck in `CreateContainerConfigError` | `woo-mcp-credentials` Secret missing | Run `helm upgrade kube-mcp charts/stack -n kube-mcp -f charts/stack/values-secrets.yaml` |
| `/shop/` returns 404 | Pretty permalinks not written | Re-run `helm upgrade`; the setup Job writes `.htaccess` |
| `127.0.0.1` returns 404 | Ingress routes by hostname | Use `store.localtest.me` or `localhost` |
| Login says `Invalid email or password` | Typed password differs from the Secret | Copy it from step 7 |
| Google sign-in shows `origin_mismatch` | Origin not allowed in Cloud Console | Add `http://localhost` (step 5) |
| A release reports `exists and cannot be imported` | A resource from an earlier separate install still exists | Uninstall the old release, or recreate the cluster |

## Security notes

- The WooCommerce key is in the `woo-mcp-credentials` Secret, and the Google client ID is in `charts/stack/values-secrets.yaml`. Both also appear in Helm's release history. That's fine for a local cluster. For a shared cluster, create the Secrets yourself and reference them from the charts.
- `GOOGLE_ALLOWED_DOMAINS` is empty, so any Google account can sign in. Set it to your company domain before sharing the dashboard with others: `--set-string gateway.auth.googleAllowedDomains=example.com`.
- The gateway's admin password is generated and kept in `gateway-secrets`. Change it after the first sign-in.
- `values-secrets.yaml` is git-ignored. Keep it out of commits.
