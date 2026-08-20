#!/usr/bin/env bash

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
backup_dir=${DATABASE_BACKUP_DIR:-/var/backups/letletme-data}
keep_count=${DATABASE_BACKUP_KEEP:-7}
expected_major=${DATABASE_BACKUP_PG_MAJOR:-15}
deploy_sha=${DEPLOY_SHA:-unknown}

case "$DATABASE_URL" in
  *pgbouncer=true*|*pooler.supabase.com*|*:6543/*)
    echo 'DATABASE_URL must be the direct PostgreSQL migration connection, not a pooler' >&2
    exit 1
    ;;
esac

case "$keep_count" in
  ''|*[!0-9]*) echo 'DATABASE_BACKUP_KEEP must be a positive integer' >&2; exit 1 ;;
esac
if [ "$keep_count" -lt 2 ]; then
  echo 'DATABASE_BACKUP_KEEP must be at least 2' >&2
  exit 1
fi
case "$expected_major" in
  ''|*[!0-9]*) echo 'DATABASE_BACKUP_PG_MAJOR must be an integer' >&2; exit 1 ;;
esac

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
if [ ! -d "$backup_dir" ] || [ ! -w "$backup_dir" ]; then
  echo "Backup directory is not writable: $backup_dir" >&2
  exit 1
fi

server_version_num=$(psql "$DATABASE_URL" -Atqc 'SHOW server_version_num')
server_major=$((server_version_num / 10000))
if [ "$server_major" -ne "$expected_major" ]; then
  echo "pg_dump image major $expected_major does not match PostgreSQL server major $server_major" >&2
  exit 1
fi

safe_sha=$(printf '%s' "$deploy_sha" | tr -cd 'A-Fa-f0-9' | cut -c1-40)
safe_sha=${safe_sha:-unknown}
timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
base_name="letletme-data-${timestamp}-${safe_sha}"
partial_path="$backup_dir/${base_name}.dump.partial"
dump_path="$backup_dir/${base_name}.dump"
manifest_partial="$backup_dir/${base_name}.manifest.json.partial"
manifest_path="$backup_dir/${base_name}.manifest.json"
checksum_partial="$backup_dir/${base_name}.sha256.partial"
checksum_path="$backup_dir/${base_name}.sha256"

cleanup() {
  rm -f -- "$partial_path" "$manifest_partial" "$checksum_partial"
}
trap cleanup EXIT

umask 077
echo "Creating PostgreSQL logical backup outside the repository"
pg_dump \
  --dbname="$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$partial_path"

test -s "$partial_path"
pg_restore --list "$partial_path" >/dev/null
checksum=$(sha256sum "$partial_path" | awk '{print $1}')
size_bytes=$(stat -c '%s' "$partial_path")
ledger_tail=$(psql "$DATABASE_URL" -Atqc \
  "SELECT COALESCE(max(filename), 'none') FROM ops.schema_migrations")

printf '%s  %s\n' "$checksum" "$(basename "$dump_path")" >"$checksum_partial"
printf '{"format":"custom","deploySha":"%s","serverMajor":%s,"createdAt":"%s","sizeBytes":%s,"sha256":"%s","migrationLedgerTail":"%s"}\n' \
  "$safe_sha" "$server_major" "$timestamp" "$size_bytes" "$checksum" "$ledger_tail" \
  >"$manifest_partial"

mv --no-target-directory -- "$partial_path" "$dump_path"
mv --no-target-directory -- "$checksum_partial" "$checksum_path"
mv --no-target-directory -- "$manifest_partial" "$manifest_path"
trap - EXIT
chmod 600 "$dump_path" "$checksum_path" "$manifest_path"

completed_dumps=()
while IFS= read -r dump_entry; do
  dump_path_candidate=${dump_entry#* }
  dump_base=${dump_path_candidate%.dump}
  # Only a dump with both atomically-written sidecars is managed by this
  # rotation.  Unknown/partial/hand-copied dumps stay untouched.
  if [ -f "${dump_base}.sha256" ] && [ -f "${dump_base}.manifest.json" ]; then
    completed_dumps+=("$dump_path_candidate")
  fi
done < <(find "$backup_dir" -maxdepth 1 -type f -name 'letletme-data-*.dump' -printf '%T@ %p\n' | sort -nr)
if [ "${#completed_dumps[@]}" -gt "$keep_count" ]; then
  for old_dump in "${completed_dumps[@]:$keep_count}"; do
    old_base=${old_dump%.dump}
    rm -f -- "$old_dump" "${old_base}.sha256" "${old_base}.manifest.json"
  done
fi

printf '{"event":"pre_migration_backup","path":"%s","sha256":"%s","sizeBytes":%s,"serverMajor":%s,"retained":%s}\n' \
  "$dump_path" "$checksum" "$size_bytes" "$server_major" "$keep_count"
