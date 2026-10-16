#!/usr/bin/env bash
set -euo pipefail

namespace="${NAMESPACE:-kube-mcp}"
recipient="${AGE_RECIPIENT:-}"
out_dir="${BACKUP_DIR:-./backups}"

if [[ -z "$recipient" ]]; then
  echo "Set AGE_RECIPIENT to an age public recipient (for example age1...)" >&2
  exit 2
fi
command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }
command -v age >/dev/null || { echo "age is required" >&2; exit 2; }
mkdir -p "$out_dir"
chmod 700 "$out_dir"
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

kubectl -n "$namespace" exec postgres-0 -- sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -Fc -U gateway gateway' > "$work/gateway.dump"
kubectl -n "$namespace" exec mariadb-0 -- sh -ec \
  'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump -uroot --single-transaction --routines --triggers wordpress' > "$work/wordpress.sql"
kubectl -n "$namespace" exec deploy/wordpress -- tar -czf - -C /var/www/html . > "$work/wordpress-files.tar.gz"

for artifact in gateway.dump wordpress.sql wordpress-files.tar.gz; do
  age -r "$recipient" -o "$out_dir/$stamp-$artifact.age" "$work/$artifact"
done
sha256sum "$out_dir/$stamp-"*.age > "$out_dir/$stamp-SHA256SUMS"
chmod 600 "$out_dir/$stamp-"*
echo "Encrypted backup written to $out_dir (copy it to storage outside this cluster)."
