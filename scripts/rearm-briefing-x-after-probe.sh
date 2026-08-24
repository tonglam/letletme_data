#!/usr/bin/env bash

set -euo pipefail

env_file=${1:-.env.deploy}
migration_env_file=${2:-.env.migrate}
output_contract_revision=${3:-${CONTENT_GROK_OUTPUT_CONTRACT_REVISION:-3}}
test -f "$env_file"
test -f "$migration_env_file"
test ! -L "$env_file"
test ! -L "$migration_env_file"
case "$output_contract_revision" in
  ''|*[!0-9]*)
    echo "invalid output contract revision" >&2
    exit 1
    ;;
esac

# This is deliberately a small, explicit recovery mutation. It never changes
# an X checkpoint or terminal run; it only closes provider circuits and brings
# identity/recurring X schedules forward with deterministic per-target jitter.
MIGRATION_ENV_FILE="$migration_env_file" docker compose --profile migration run \
  --rm -T --no-deps --env CONTRACT_REVISION="$output_contract_revision" --entrypoint sh backup -euc \
  'exec psql "$DATABASE_URL" -X -qAt --set=ON_ERROR_STOP=1 --set=contract_revision="${CONTRACT_REVISION}"' <<'SQL'
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
    AND identity_status IN ('PENDING', 'FAILED')
)
UPDATE content.source_endpoints AS endpoint
SET identity_next_check_at = LEAST(
      COALESCE(endpoint.identity_next_check_at, now() + due.jitter),
      now() + due.jitter
    ),
    updated_at = now()
FROM due
WHERE endpoint.endpoint_id = due.endpoint_id;

WITH latest_runner_failure AS (
  SELECT DISTINCT ON (schedule_id)
         schedule_id,
         status,
         failure_class,
         run_metrics
  FROM content.acquisition_runs
  WHERE schedule_id IS NOT NULL
  ORDER BY schedule_id, completed_at DESC NULLS LAST, created_at DESC, run_id DESC
)
UPDATE content.source_schedules AS schedule
SET failure_streak = 0,
    circuit_state = 'CLOSED',
    probe_after = NULL,
    next_due_at = LEAST(
      schedule.next_due_at,
      now() + make_interval(secs => mod((hashtext(schedule.schedule_id::text)::bigint & 2147483647), 121))
    ),
    updated_at = now()
FROM latest_runner_failure
WHERE schedule.status = 'active'
  AND schedule.adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC')
  AND schedule.circuit_state = 'OPEN'
  AND latest_runner_failure.schedule_id = schedule.schedule_id
  AND latest_runner_failure.status IN ('FAILED', 'GAP')
  AND latest_runner_failure.failure_class IN (
    'RUNNER_CAPACITY',
    'RUNNER_UNAVAILABLE',
    'RUNNER_TIMEOUT',
    'RUNNER_NOT_READY',
    'RUNNER_RELEASE_MISMATCH',
    'RUNNER_IDENTITY_MISMATCH',
    'RUNNER_TRANSPORT_AFTER_DISPATCH',
    'RUNNER_RESPONSE_INVALID',
    'GROK_VERSION_MISMATCH'
  );

WITH latest_contract_failure AS (
  SELECT DISTINCT ON (schedule_id)
         schedule_id,
         status,
         failure_class,
         run_metrics
  FROM content.acquisition_runs
  WHERE schedule_id IS NOT NULL
  ORDER BY schedule_id, completed_at DESC NULLS LAST, created_at DESC, run_id DESC
)
UPDATE content.source_schedules AS schedule
SET failure_streak = 1,
    circuit_state = 'CLOSED',
    probe_after = NULL,
    next_due_at = LEAST(
      schedule.next_due_at,
      now() + make_interval(secs => mod((hashtext(schedule.schedule_id::text)::bigint & 2147483647), 121))
    ),
    updated_at = now()
FROM latest_contract_failure
WHERE schedule.status = 'active'
  AND schedule.adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC')
  AND schedule.circuit_state = 'OPEN'
  AND latest_contract_failure.schedule_id = schedule.schedule_id
  AND latest_contract_failure.status IN ('FAILED', 'GAP')
  AND latest_contract_failure.failure_class IN ('GROK_FINAL_INVALID', 'GROK_FINAL_SCHEMA_INVALID')
  AND COALESCE((latest_contract_failure.run_metrics ->> 'outputContractRevision')::integer, 0)
      < :'contract_revision'::integer;
COMMIT;
SQL

printf '%s\n' "{\"event\":\"briefing_x_provider_rearmed\",\"checkpointChanged\":false,\"outputContractRevision\":$output_contract_revision}"
