#!/usr/bin/env bash
# Bootstrap a cluster for GitOps. Run once per cluster; running it again changes nothing.
#
#   PUBLIC_IP=13.200.126.173 KUBECONFIG=~/.kube/kube-mcp-aws.yaml ./scripts/bootstrap.sh
#
# 1. Creates the namespace and the secrets Helm must not generate (generated once, never rotated).
# 2. Creates the self-signed certificate for the bare IP.
# 3. Installs Argo CD.
# 4. Applies the root app. From then on Argo CD deploys everything in gitops/ from GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PUBLIC_IP:?set PUBLIC_IP to the public IP of the server}"
NS=kube-mcp
ARGO_CHART_VERSION=10.10.2

need() { command -v "$1" >/dev/null || { echo "missing: $1"; exit 1; }; }
for c in kubectl helm openssl; do need "$c"; done

# Create a secret only if it does not exist yet. Values never leave this shell.
ensure_secret() {
  local name=$1; shift
  if kubectl -n "$NS" get secret "$name" >/dev/null 2>&1; then
    echo "exists: $name"
  else
    kubectl -n "$NS" create secret generic "$name" "$@" >/dev/null
    echo "created: $name"
  fi
}

kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS" >/dev/null

ensure_secret store-secrets \
  --from-literal=mariadb-root-password="$(openssl rand -hex 16)" \
  --from-literal=mariadb-password="$(openssl rand -hex 16)" \
  --from-literal=wp-admin-password="$(openssl rand -hex 12)"

ensure_secret woo-mcp-credentials \
  --from-literal=consumer-key="ck_$(openssl rand -hex 20)" \
  --from-literal=consumer-secret="cs_$(openssl rand -hex 20)"

ensure_secret gateway-secrets \
  --from-literal=postgres-password="$(openssl rand -hex 16)" \
  --from-literal=gateway-encryption-key="$(openssl rand -base64 32)" \
  --from-literal=bootstrap-admin-password="$(openssl rand -hex 12)"

if kubectl -n "$NS" get secret ip-tls >/dev/null 2>&1; then
  echo "exists: ip-tls"
else
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$tmp/tls.key" -out "$tmp/tls.crt" \
    -subj "/CN=$PUBLIC_IP" -addext "subjectAltName=IP:$PUBLIC_IP" 2>/dev/null
  kubectl -n "$NS" create secret tls ip-tls --cert="$tmp/tls.crt" --key="$tmp/tls.key" >/dev/null
  echo "created: ip-tls (self-signed, for https://$PUBLIC_IP)"
fi

helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
helm repo update argo >/dev/null
helm upgrade --install argocd argo/argo-cd --version "$ARGO_CHART_VERSION" \
  -n argocd --create-namespace -f infra/aws/argocd/values.yaml --wait --timeout 10m
echo "installed: argocd"

kubectl apply -f gitops/root.yaml
echo "applied: root app. Argo CD now syncs gitops/apps from GitHub."
echo "Argo CD admin password: kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo"
echo "Argo CD UI: kubectl -n argocd port-forward svc/argocd-server 8081:443  then https://localhost:8081"
