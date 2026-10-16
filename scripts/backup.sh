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
if [[ ! -d "$out_dir" ]]; then mkdir -p -m 700 "$out_dir"; fi
umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
stage="$(mktemp -d "$out_dir/.backup-$timestamp.XXXXXX")"
stamp="$timestamp-${stage##*.}"
trap 'rm -rf "$stage"' EXIT

kubectl -n "$namespace" exec postgres-0 -- sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -Fc -U gateway gateway' \
  | age -r "$recipient" -o "$stage/$stamp-gateway.dump.age"
kubectl -n "$namespace" exec mariadb-0 -- sh -ec \
  'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump -uroot --single-transaction --routines --triggers wordpress' \
  | age -r "$recipient" -o "$stage/$stamp-wordpress.sql.age"
kubectl -n "$namespace" exec deploy/wordpress -- tar -czf - -C /var/www/html . \
  | age -r "$recipient" -o "$stage/$stamp-wordpress-files.tar.gz.age"

(cd "$stage" && sha256sum "$stamp-"*.age) > "$stage/$stamp-SHA256SUMS"
chmod 600 "$stage/$stamp-"*
mv "$stage/$stamp-"*.age "$out_dir/"
mv "$stage/$stamp-SHA256SUMS" "$out_dir/"
echo "Encrypted backup written to $out_dir (copy it to storage outside this cluster)."
