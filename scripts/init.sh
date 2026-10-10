#!/usr/bin/env bash
# One-command setup of the whole stack on a local Kind cluster.
# Asks for the two values that can't live in the repo, then runs one Helm install.
set -euo pipefail

cd "$(dirname "$0")/.."
NS=kube-mcp
RELEASE=kube-mcp
VALUES=charts/stack/values-secrets.yaml

need() { command -v "$1" >/dev/null || { echo "missing: $1 (see README.md, Prerequisites)"; exit 1; }; }
for c in docker kind kubectl helm; do need "$c"; done

# 1. Cluster
if ! kind get clusters 2>/dev/null | grep -qx kube-mcp; then
  kind create cluster --config infra/kind/kind.yaml
fi
kubectl config use-context kind-kube-mcp >/dev/null

# 2. Google OAuth client ID, written to a git-ignored values file (never printed)
if [ ! -f "$VALUES" ]; then
  printf 'Google OAuth client ID (ends in .apps.googleusercontent.com): '
  read -r GID
  [ -n "$GID" ] || { echo "client ID is required"; exit 1; }
  umask 077
  cat > "$VALUES" <<YAML
# Local secrets for the stack. Git-ignored.
gateway:
  auth:
    googleClientId: "$GID"
YAML
  unset GID
fi

# 3. One Helm install for the whole stack
helm upgrade --install "$RELEASE" charts/stack -n "$NS" --create-namespace -f "$VALUES"

# 4. Wait for the store
kubectl -n "$NS" wait --for=condition=complete job/store-setup --timeout=15m

# 5. WooCommerce key, stored as a Secret (woo-mcp waits for it)
if ! kubectl -n "$NS" get secret woo-mcp-credentials >/dev/null 2>&1; then
  cat <<'MSG'

Create the WooCommerce REST key now:
  1. Open http://store.localtest.me/wp-admin, sign in as admin
     (password: see README, "Admin passwords").
  2. WooCommerce > Settings > Advanced > REST API > Add key
     User: admin, Permissions: Read/Write, then Generate.
Then come back here.
MSG
  printf 'Consumer key (ck_...): '; read -r -s CK; echo
  printf 'Consumer secret (cs_...): '; read -r -s CS; echo
  kubectl -n "$NS" create secret generic woo-mcp-credentials \
    --from-literal=consumer-key="$CK" --from-literal=consumer-secret="$CS"
  unset CK CS
  kubectl -n "$NS" rollout restart deploy/woo-mcp
fi
kubectl -n "$NS" rollout status deploy/woo-mcp --timeout=3m

# 6. Port 8080 for the gateway
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx kube-mcp-gateway-proxy; then
  docker rm -f kube-mcp-gateway-proxy >/dev/null 2>&1 || true
  docker run -d --name kube-mcp-gateway-proxy --restart unless-stopped \
    --network kind -p 127.0.0.1:8080:8080 \
    alpine/socat TCP-LISTEN:8080,fork,reuseaddr TCP:kube-mcp-control-plane:80 >/dev/null
fi

echo
echo "Done."
echo "  Store:     http://store.localtest.me"
echo "  Dashboard: http://localhost:8080   (user admin@example.com)"
echo "  Gateway admin password: see README, \"Admin passwords\""
