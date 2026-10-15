# Local setup: Kind with Calico

This runs the whole stack on one machine, using the plain manifests in `yamls/`. The cluster uses Calico, so the NetworkPolicies are enforced. kind's default networking doesn't enforce them.

The same design is packaged as Helm charts in `charts/`, which are what AWS deploys. See [Helm alternative](#helm-alternative) at the end.

## What runs where

| Namespace | Workloads | Manifests | Reached at |
|---|---|---|---|
| `ingress-nginx` | ingress controller | `yamls/ingress/00-ingress-nginx-kind.yaml` | ports 80 and 443 on your machine |
| `store` | WordPress, MariaDB, store setup Job, woo-mcp | `yamls/store/`, `yamls/mcp/00-mcp.yaml` | `http://store.localtest.me` |
| `gateway` | gateway, dashboard, Postgres | `yamls/Gateway/` | `http://localhost` and `http://kube-mcp.localtest.me` |

`*.localtest.me` is public DNS that resolves to `127.0.0.1`, so no `/etc/hosts` edits are needed.

## 1. Prerequisites

Docker, `kind`, `kubectl`, and `openssl`. Ports **80**, **443** and **8443** must be free.

## 2. Create the cluster with Calico

```sh
kind create cluster --config infra/kind/kind-calico.yaml
kubectl apply -f infra/kind/calico-v3.32.2.yaml
kubectl -n kube-system rollout status ds/calico-node --timeout=300s
kubectl wait --for=condition=Ready node --all --timeout=300s
```

`kind-calico.yaml` turns off kind's default network plugin. `calico-v3.32.2.yaml` is the Calico manifest, saved in the repo. `infra/kind/kind.yaml` is the older config for the default plugin; it doesn't enforce NetworkPolicy.

## 3. Build and load the images

The node can't pull the locally built images, so build them and load them into the node. The `docker save | cat` form is needed when Docker is installed as a snap, since snap Docker can't write to `/tmp`.

```sh
docker build --provenance=false --sbom=false -t woo-mcp:0.1.0 services/woo-mcp
docker build --provenance=false --sbom=false -t gateway:0.2.4 services/gateway
docker build --provenance=false --sbom=false -t dashboard:0.8.1 dashboard

for img in woo-mcp:0.1.0 gateway:0.2.4 dashboard:0.8.1; do
  docker save --platform linux/amd64 $img | cat > /tmp/load.tar
  cat /tmp/load.tar | docker exec -i kube-mcp-control-plane ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs -
done
rm -f /tmp/load.tar
```

The tags must match the `image:` lines in the manifests. If you build a new version, change the tag in the manifest too. Reusing a tag keeps the old image on the node, because the pull policy is `IfNotPresent`.

The ingress controller image is pulled from `registry.k8s.io` by the node itself. If the node can't reach it, pull it on the host and load it the same way.

## 4. Namespaces, secrets, then workloads

Create the secrets first, because the workloads read them. The values are random. The store values must match what the setup Job registers with WooCommerce.

```sh
kubectl apply -f yamls/store/00-namespace.yaml
kubectl apply -f yamls/Gateway/00-namespace.yaml

rnd() { openssl rand -hex "$1"; }

kubectl -n store create secret generic store-secrets \
  --from-literal=mariadb-root-password="$(rnd 16)" \
  --from-literal=mariadb-password="$(rnd 16)" \
  --from-literal=wp-admin-password="$(rnd 16)"

kubectl -n store create secret generic woo-mcp-credentials \
  --from-literal=consumer-key="ck_$(rnd 20)" \
  --from-literal=consumer-secret="cs_$(rnd 20)"

kubectl -n gateway create secret generic gateway-secrets \
  --from-literal=postgres-password="$(rnd 24)" \
  --from-literal=gateway-encryption-key="$(openssl rand -base64 32)" \
  --from-literal=bootstrap-admin-password="$(rnd 16)"
```

Do not apply `yamls/store/01-secrets.yaml` as it is. It holds `CHANGE_ME` placeholders for reference. Keep the generated values somewhere private: the gateway encryption key is needed to read stored upstream credentials later.

Apply the ingress controller and the store:

```sh
kubectl apply -f yamls/ingress/00-ingress-nginx-kind.yaml
kubectl -n ingress-nginx wait --for=condition=Ready pod -l app.kubernetes.io/component=controller --timeout=300s

kubectl apply -f yamls/store/02-mariadb.yaml
kubectl -n store rollout status statefulset/mariadb --timeout=300s
kubectl apply -f yamls/store/03-wordpress.yaml
kubectl -n store rollout status deploy/wordpress --timeout=600s
kubectl apply -f yamls/store/04-setup.yaml
kubectl -n store wait --for=condition=complete job/store-setup --timeout=15m
kubectl apply -f yamls/store/05-networkpolicies.yaml -f yamls/store/06-ingress.yaml
```

The setup Job installs WordPress and WooCommerce, loads the sample products, and registers the WooCommerce key. It runs once. To run it again, delete it first with `kubectl -n store delete job store-setup`.

Then the MCP server, the gateway and the dashboard:

```sh
kubectl apply -f yamls/mcp/00-mcp.yaml
kubectl -n store rollout status deploy/mcp --timeout=180s

kubectl apply -f yamls/Gateway/01-postgres.yaml
kubectl -n gateway rollout status statefulset/postgres --timeout=300s
kubectl apply -f yamls/Gateway/02-gateway.yaml
kubectl -n gateway rollout status deploy/gateway --timeout=240s
kubectl apply -f yamls/Gateway/03-dashboard.yml
kubectl -n gateway rollout status deploy/dashboard --timeout=240s
kubectl apply -f yamls/Gateway/04-ingress.yaml -f yamls/Gateway/05-networkpolicies.yaml
```

The gateway's `DATABASE_URL` and the Postgres `POSTGRES_DB` must name the same database. The manifests use `mcp-db` for the database and `mcp` for the user.

## 5. Check it

```sh
kubectl get pods -A | grep -vE "Running|Completed" || echo "all pods are running"

curl -s -o /dev/null -w "dashboard       %{http_code}\n" http://localhost/
curl -s -o /dev/null -w "gateway ready   %{http_code}\n" http://localhost/readyz
curl -s -o /dev/null -w "store           %{http_code}\n" http://store.localtest.me/shop/
```

Expected: `200` for all three. Then sign in at `http://localhost`:

- **Email:** `admin@example.com`, the bootstrap admin in `yamls/Gateway/02-gateway.yaml`.
- **Password:** `kubectl -n gateway get secret gateway-secrets -o jsonpath='{.data.bootstrap-admin-password}' | base64 -d; echo`

Check the policies with a pod that is not allowed through. From the `default` namespace it should time out, and from the gateway it should connect:

```sh
kubectl -n default run np-test --image=woo-mcp:0.1.0 --image-pull-policy=IfNotPresent --restart=Never --rm -i --quiet --command -- \
  sh -c 'nc -z -w3 wordpress.store.svc.cluster.local 80 && echo ALLOWED || echo BLOCKED'
```

## 6. Changing things later

- **Code change:** rebuild the image with a new tag, load it (step 3), set the new tag in the manifest, then `kubectl apply` and check the rollout.
- **Manifest change:** edit the file and `kubectl apply -f` it. Secrets are not touched by re-applying the workload manifests.
- **Reset:** `kind delete cluster --name kube-mcp` removes everything, including the store and gateway data.

## Helm alternative

The charts in `charts/stack` install the same stack in one release, with `charts/stack/values-dev.yaml` for local use and `values-prod.yaml` for AWS. The local Helm path was last checked before the roles and permissions change, so verify it before relying on it:

```sh
helm install kube-mcp charts/stack -n kube-mcp --create-namespace -f charts/stack/values-secrets.yaml -f charts/stack/values-dev.yaml
```

`charts/stack/values-secrets.example.yaml` lists the one value that isn't generated: the Google OAuth client ID.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Pods stay `Pending` after the cluster starts | Calico isn't ready yet | Wait for `calico-node` (step 2) |
| `ImagePullBackOff` on `gateway`, `dashboard` or `mcp` | The image isn't on the node, or the tag doesn't match | Load it (step 3) and check the `image:` line |
| `ctr: unrecognized image format` on load | The image was saved in a format kind can't read | Use the `docker save --platform linux/amd64 \| cat` form |
| `CreateContainerConfigError` | A Secret or key is missing | Re-create it (step 4) and check the key names |
| `CreateContainerConfigError` on the store | `store-secrets` or `woo-mcp-credentials` not created | Create them first |
| Gateway restarts with `column ... does not exist` | An old database is being migrated | Read the gateway log; the migration adds the missing column at startup |
| Store returns 404 on `/shop/` | Permalinks not written | Check the setup Job's log |
| `origin_mismatch` on Google sign-in | The origin isn't allowed in Google Cloud | Add `http://localhost` under *Authorized JavaScript origins* |
