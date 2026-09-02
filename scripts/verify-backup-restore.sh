#!/usr/bin/env bash

set -euo pipefail

dump_path=${1:?usage: verify-backup-restore.sh /container/path/to/file.dump}
target_url=${2:?usage: verify-backup-restore.sh /container/path/to/file.dump postgresql://target postgresql://source}
source_url=${3:?usage: verify-backup-restore.sh /container/path/to/file.dump postgresql://target postgresql://source}
dump_dir=$(dirname "$dump_path")
dump_base=$(basename "$dump_path" .dump)
checksum_path="$dump_dir/${dump_base}.sha256"
manifest_path="$dump_dir/${dump_base}.manifest.json"

test -f "$dump_path"
test -s "$dump_path"
test -f "$checksum_path"
test -f "$manifest_path"
grep -q '"format":"custom"' "$manifest_path"
(cd "$dump_dir" && sha256sum -c "$(basename "$checksum_path")")
manifest_sha=$(sed -n 's/.*"sha256":"\([0-9a-fA-F]\{64\}\)".*/\1/p' "$manifest_path")
sidecar_sha=$(awk 'NR == 1 { print $1 }' "$checksum_path")
test -n "$manifest_sha"
test "$manifest_sha" = "$sidecar_sha"
manifest_size=$(sed -n 's/.*"sizeBytes":\([0-9][0-9]*\).*/\1/p' "$manifest_path")
test -n "$manifest_size"
test "$(stat -c '%s' "$dump_path")" = "$manifest_size"
manifest_major=$(sed -n 's/.*"serverMajor":\([0-9][0-9]*\).*/\1/p' "$manifest_path")
manifest_ledger_tail=$(sed -n 's/.*"migrationLedgerTail":"\([^"]*\)".*/\1/p' "$manifest_path")
test -n "$manifest_major"
test -n "$manifest_ledger_tail"
pg_restore --list "$dump_path" >/dev/null
psql "$target_url" -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null
identity_query="SELECT current_database() || '|' || COALESCE(inet_server_addr()::text, 'local') || '|' || COALESCE(inet_server_port()::text, '0') || '|' || (SELECT oid::text FROM pg_database WHERE datname = current_database())"
source_identity=$(psql "$source_url" -v ON_ERROR_STOP=1 -Atqc "$identity_query")
target_identity=$(psql "$target_url" -v ON_ERROR_STOP=1 -Atqc "$identity_query")
test -n "$source_identity"
test -n "$target_identity"
if [[ "$source_identity" = "$target_identity" ]]; then
  echo 'backup restore rehearsal target has the same database identity as the source' >&2
  exit 1
fi
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$target_url" "$dump_path"
target_major=$(psql "$target_url" -Atqc 'SHOW server_version_num')
target_major=$((target_major / 10000))
test "$target_major" = "$manifest_major"
ledger_tail=$(psql "$target_url" -v ON_ERROR_STOP=1 -Atqc \
  "SELECT COALESCE(max(filename), 'none') FROM ops.schema_migrations")
test "$ledger_tail" = "$manifest_ledger_tail"
key_counts=$(psql "$target_url" -v ON_ERROR_STOP=1 -Atqc \
  "SELECT jsonb_build_object(
     'players', (SELECT count(*) FROM fpl.players),
     'events', (SELECT count(*) FROM fpl.events),
     'fixtures', (SELECT count(*) FROM fpl.fixtures),
     'publications', (SELECT count(*) FROM content.publications)
   )::text")
printf '{"event":"backup_restore_verified","targetPgMajor":%s,"migrationLedgerTail":"%s","keyCounts":%s}\n' \
  "$target_major" "$ledger_tail" "$key_counts"
