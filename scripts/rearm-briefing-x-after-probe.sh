#!/usr/bin/env bash

set -euo pipefail

env_file=${1:-.env.deploy}
migration_env_file=${2:-.env.migrate}
test -f "$env_file"
test -f "$migration_env_file"
test ! -L "$env_file"
test ! -L "$migration_env_file"

# This is deliberately a small, explicit recovery mutation. It never changes
# an X checkpoint or terminal run; it only closes provider circuits and brings
# identity/recurring X schedules forward with deterministic per-target jitter.
MIGRATION_ENV_FILE="$migration_env_file" docker compose --profile migration run \
  --rm -T --no-deps --entrypoint sh backup -euc \
  'exec psql "$DATABASE_URL" -X -qAt --set=ON_ERROR_STOP=1' <<'SQL'
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '20s';
SELECT pg_advisory_xact_lock(hashtext('briefing-x-capacity-v1'));

WITH due AS (
  SELECT endpoint_id,
         make_interval(secs => mod((hashtext(endpoint_id::text)::bigint & 2147483647), 121)) AS jitter
  FROM content.source_endpoints
  WHERE adapter_kind = 'X_ACCOUNT'
    AND status = 'active'
)
UPDATE content.source_endpoints AS endpoint
SET identity_next_check_at = LEAST(
      COALESCE(endpoint.identity_next_check_at, now() + due.jitter),
      now() + due.jitter
    ),
    updated_at = now()
FROM due
WHERE endpoint.endpoint_id = due.endpoint_id;

UPDATE content.source_schedules AS schedule
SET failure_streak = 0,
    circuit_state = 'CLOSED',
    probe_after = NULL,
    next_due_at = LEAST(
      schedule.next_due_at,
      now() + make_interval(secs => mod((hashtext(schedule.schedule_id::text)::bigint & 2147483647), 121))
    ),
    updated_at = now()
WHERE schedule.status = 'active'
  AND schedule.adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC');
COMMIT;
SQL

printf '%s\n' '{"event":"briefing_x_provider_rearmed","checkpointChanged":false}'
