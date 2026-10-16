# Setup and deployment

This guide describes the supported local Helm path first, then the optional Calico and plain-manifest paths. The default local bootstrap uses Kind's default networking; NetworkPolicy objects are installed but are not enforced by kindnet. Use the Calico path when you need policy enforcement locally.

## Local Kind setup (Helm)

### Requirements

- Docker Engine
- Kind
- kubectl
- Helm 3
- Host TCP port 80 available

From the repository root:

```sh
./scripts/init.sh
```

The script creates a one-node cluster called `kube-mcp` if it is absent, selects `kind-kube-mcp`, builds and imports the local app images, and runs `helm upgrade --install` for release `kube-mcp` in namespace `kube-mcp`. It uses `charts/stack/values-dev.yaml`. The script waits for the `store-setup` job and `woo-mcp` rollout.

The initial install pulls base and third-party images such as WordPress, MariaDB, PostgreSQL, and ingress-nginx. Application images are built from this checkout, not pulled from GHCR.

Open <http://localhost> for the dashboard and <http://store.localtest.me> for the store. Use `admin@example.com` to sign in. Retrieve the generated bootstrap password with:

```sh
kubectl -n kube-mcp get secret gateway-secrets \
  -o jsonpath='{.data.bootstrap-admin-password}' | base64 -d; echo
```

Check the install:

```sh
kubectl get nodes
kubectl -n kube-mcp get pods,svc,ingress,pvc
helm -n kube-mcp status kube-mcp
curl -fsS -o /dev/null -w 'dashboard: %{http_code}\n' http://localhost/
curl -fsS -o /dev/null -w 'gateway: %{http_code}\n' http://localhost/healthz
curl -fsS -o /dev/null -w 'store: %{http_code}\n' http://store.localtest.me/
```

The dashboard and store should return HTTP 200. The store setup job should be `Completed`; deployments and database pods should be `Ready`.

### Rebuild and refresh a local image

The local tags use `IfNotPresent`. Reusing a tag does not trigger a rollout by itself. Build, import, and restart the matching deployment:

```sh
docker build --provenance=false --sbom=false -t dashboard:0.8.1 dashboard
docker save --platform linux/amd64 dashboard:0.8.1 | \
  docker exec -i kube-mcp-control-plane ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs -
kubectl -n kube-mcp rollout restart deployment/dashboard
kubectl -n kube-mcp rollout status deployment/dashboard --timeout=3m
```

For the other services use their build contexts, image tags, and deployment names from `charts/stack/values-dev.yaml`: `services/gateway` / `gateway:0.2.4` / `gateway`, and `services/woo-mcp` / `woo-mcp:0.1.0` / `woo-mcp`. The direct containerd import is useful when `kind load docker-image` fails because Docker cannot create Kind's temporary export path.

To apply chart or values changes without rebuilding images:

```sh
helm upgrade kube-mcp charts/stack -n kube-mcp -f charts/stack/values-dev.yaml
```

### Optional: enforce NetworkPolicies on Kind with Calico

The default `infra/kind/kind.yaml` used by `scripts/init.sh` leaves kindnet enabled. kindnet does not enforce Kubernetes NetworkPolicies. For a local policy-enforced cluster, create a fresh cluster with the alternate config, install the pinned Calico manifest, wait for Calico, then run the normal bootstrap:

```sh
kind create cluster --config infra/kind/kind-calico.yaml
kubectl apply -f infra/kind/calico-v3.32.2.yaml
kubectl -n kube-system rollout status daemonset/calico-node --timeout=5m
kubectl wait --for=condition=Ready node --all --timeout=5m
./scripts/init.sh
```

The bootstrap script detects the existing `kube-mcp` cluster and installs the stack into it. Do not create the Calico cluster on top of an existing Kind cluster with that name. Calico uses extra pod CIDR space configured in `kind-calico.yaml`; keep it consistent with the checked-in Calico manifest.

### Remove a local cluster

Deleting the cluster also deletes its databases, uploaded store files, generated credentials, and any other cluster state:

```sh
kind delete cluster --name kube-mcp
```

## Plain Kubernetes manifests (alternate local path)

`yamls/` is a separate, manually applied deployment path. It uses multiple namespaces and includes a manual install order in the manifests; it is not what `scripts/init.sh` applies. The Helm stack is the recommended path for a full local install. If you choose the raw manifests, review each manifest and create the namespace-scoped Secrets before starting workloads. The checked-in `yamls/store/01-secrets.yaml` contains placeholders and must not be applied unchanged.

The raw manifests and Helm templates are two representations of the stack, so changes may need to be kept aligned. They are not interchangeable against an existing database without checking database names and namespaces.

## Production-like AWS deployment

The AWS path is a small k3s environment, not a managed high-availability Kubernetes service. Terraform provisions two Ubuntu EC2 instances, a security group, and an Elastic IP. It does not install k3s; server/agent installation and kubeconfig setup are operator steps.

### Provision the AWS nodes

Configure AWS credentials and an EC2 key pair. The default public key path is `~/.ssh/kube-mcp-k3s.pub`. Review `infra/aws/k3s/variables.tf`, `main.tf`, the region, instance type, VPC, and security group rules. Set `admin_cidr` to your current public IP with a `/32` mask:

```sh
cd infra/aws/k3s
terraform init
terraform plan \
  -var "admin_cidr=$(curl -fsS https://checkip.amazonaws.com)/32" \
  -out=tfplan
terraform apply tfplan
terraform output
```

The plan creates billable AWS resources. Inspect the plan and cost before applying. The Terraform output includes public and private instance addresses. Keep the server's public address for web ingress and kubeconfig access; the agent joins the server by its private address.

### Install k3s and configure kubectl

Install the same pinned k3s release on both nodes. Choose and record a supported version (`K3S_VERSION`) for the environment; do not let server and agent silently drift to different releases. On the server, include the public address in the API certificate SAN, then install the server:

```sh
sudo install -d -m 0755 /etc/rancher/k3s
printf 'tls-san:\n  - %s\n' "$PUBLIC_IP" | sudo tee /etc/rancher/k3s/config.yaml
curl -sfL https://get.k3s.io | sudo env INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server
```

Retrieve the node token securely from the server's `/var/lib/rancher/k3s/server/node-token`. On the agent, join over the private address:

```sh
curl -sfL https://get.k3s.io | \
  sudo env INSTALL_K3S_VERSION="$K3S_VERSION" \
    K3S_URL="https://$SERVER_PRIVATE_IP:6443" K3S_TOKEN="$K3S_TOKEN" sh -s - agent
```

Do not put the node token in Git or a shared terminal transcript. The security group should allow the API from your administrator CIDR and between the nodes, and the k3s node traffic described in [Networking](NETWORKING.md).

Copy `/etc/rancher/k3s/k3s.yaml` from the server to a private local file, set restrictive permissions, and replace the `127.0.0.1` API address with the server's public IP. Then set `KUBECONFIG` to that file and confirm both nodes are Ready:

```sh
export KUBECONFIG="$HOME/.kube/kube-mcp-aws.yaml"
kubectl get nodes -o wide
```

### Bootstrap GitOps

From the repository root, use the server IP and the kubeconfig for that cluster:

```sh
PUBLIC_IP="$SERVER_PUBLIC_IP" KUBECONFIG="$HOME/.kube/kube-mcp-aws.yaml" ./scripts/bootstrap.sh
```

The script creates the `kube-mcp` namespace-scoped runtime Secrets once, creates the self-signed bare-IP certificate, installs Argo CD, and applies `gitops/root.yaml`. Argo CD reads `gitops/apps/kube-mcp.yaml` and deploys `charts/stack` with `values-prod.yaml`. cert-manager and its issuer are ordered before the stack through sync waves.

Use the HTTPS dashboard and store hosts configured in `charts/stack/values-prod.yaml`. The dashboard bootstrap account is `admin@example.com`; read its generated password from the Kubernetes Secret:

```sh
kubectl -n kube-mcp get secret gateway-secrets \
  -o jsonpath='{.data.bootstrap-admin-password}' | base64 -d; echo
```

Argo CD is a ClusterIP service, not a public endpoint. To open it temporarily:

```sh
kubectl -n argocd port-forward svc/argocd-server 9090:443
```

Then visit <https://localhost:9090>. The initial Argo CD password is in `argocd-initial-admin-secret`:

```sh
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d; echo
```

The checked-in prod values include example hostnames/IP-specific settings. Replace the hostnames, public base URL, store URL, Google OAuth origin, and callback URLs to match the environment before exposing a deployment. Review the Terraform instance type, storage, ingress rules, and resource limits for your expected use. Do not commit runtime credentials.

To roll out production code, the GitHub image workflow publishes application images and updates `charts/stack/values-prod.yaml`; Argo CD then reconciles Git. A chart-only change also reaches the cluster through GitOps. Revert the deployment commit to roll back. See [Operations and scaling](OPERATIONS-AND-SCALING.md) and [Networking](NETWORKING.md).

## Troubleshooting

| Symptom | Check |
|---|---|
| `scripts/init.sh` says port 80 is busy | Stop the local service that owns port 80, or choose another mapped host port and update your local access URLs. |
| App image is `ImagePullBackOff` | Confirm the dev image tag matches `values-dev.yaml` and that it was imported into `kube-mcp-control-plane`. |
| Pods are `Pending` | Inspect `kubectl -n kube-mcp describe pod <pod>` and node capacity, PVC status, and storage-class availability. |
| `CreateContainerConfigError` | Check the referenced Secret and key names with `kubectl -n kube-mcp describe pod <pod>`. |
| Store setup job is still running | Read `kubectl -n kube-mcp logs job/store-setup`; first install can take time while WordPress and sample products initialize. |
| Gateway readiness fails | Check `kubectl -n kube-mcp logs deploy/gateway` and `kubectl -n kube-mcp get pods,svc,pvc`; readiness requires PostgreSQL. |
| Google OAuth rejects the origin | Add the exact origin, including scheme and port, in the OAuth client's authorized JavaScript origins. Local is `http://localhost`. |
| NetworkPolicy test still connects on default Kind | This is expected with kindnet. Recreate using the Calico steps above before treating policies as enforced. |

## More guides

- [System design and tradeoffs](SYSTEM-DESIGN-AND-TRADEOFFS.md)
- [Operations and scaling](OPERATIONS-AND-SCALING.md)
- [Networking and policies](NETWORKING.md)
- [WooCommerce store details](STORE-SETUP.md)
- [Threat model](THREAT-MODEL.md)
