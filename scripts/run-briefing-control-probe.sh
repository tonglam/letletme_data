#!/usr/bin/env bash

set -euo pipefail

env_file=${1:-.env.deploy}
migration_env_file=${2:-.env.migrate}
release_sha=${3:-}
socket_path=${4:-/run/letletme-grok-runner/runner.sock}

test -f "$env_file"
test -f "$migration_env_file"
test ! -L "$env_file"
test ! -L "$migration_env_file"
if [[ ! "$release_sha" =~ ^[0-9a-f]{7,128}$ ]]; then
  echo 'usage: run-briefing-control-probe.sh ENV_FILE MIGRATION_ENV_FILE RELEASE_SHA [SOCKET_PATH]' >&2
  exit 2
fi

read_env_setting() {
  local key=$1
  local file=$2
  local value
  value=$(awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      sub("^[[:space:]]*" key "[[:space:]]*=", "", $0)
      print
      exit
    }
  ' "$file")
  value=${value#\"}
  value=${value%\"}
  value=${value#\'}
  value=${value%\'}
  printf '%s' "$value"
}

daily_limit=${CONTENT_X_DAILY_CALL_LIMIT:-$(read_env_setting CONTENT_X_DAILY_CALL_LIMIT "$env_file")}
daily_limit=${daily_limit:-2400}
if [[ ! "$daily_limit" =~ ^[1-9][0-9]*$ ]]; then
  echo 'CONTENT_X_DAILY_CALL_LIMIT must be a positive integer' >&2
  exit 2
fi

run_id=$(cat /proc/sys/kernel/random/uuid)
reservation_id=$(cat /proc/sys/kernel/random/uuid)
ledger_id=$(cat /proc/sys/kernel/random/uuid)
trace_id=$(cat /proc/sys/kernel/random/uuid)
request_hash=abc5d750ecc73ec94b6d8c68411595f0ed83ba90d07342c3abc16b95133587bb
idempotency_key="briefing-control-probe:${release_sha}:${run_id}"

psql_exec() {
  MIGRATION_ENV_FILE="$migration_env_file" docker compose --profile migration run \
    --rm -T --no-deps --entrypoint psql backup \
    -X -qAt --set=ON_ERROR_STOP=1 "$@"
}

reservation_state=$(psql_exec \
  --set=run_id="$run_id" \
  --set=reservation_id="$reservation_id" \
  --set=ledger_id="$ledger_id" \
  --set=idempotency_key="$idempotency_key" \
  --set=request_hash="$request_hash" \
  --set=daily_limit="$daily_limit" <<'SQL'
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '20s';

-- A deploy shell can be interrupted after this transaction reserves the
-- control-probe unit but before finalize_probe runs. Recover only the
-- explicitly tagged control-probe rows; ordinary acquisition runs use their
-- own lease reclaimer. We commit conservatively because the host process may
-- already have started, and leave an audit trace explaining the ambiguity.
\o /dev/null
SELECT pg_advisory_xact_lock(hashtext('briefing-x-budget-v1'));
SELECT set_config('briefing.request_hash', :'request_hash', true);

DO $recover$
DECLARE
  stale RECORD;
  reservation RECORD;
  committed_units numeric;
  trace_count integer;
  digest text;
  trace_uuid uuid;
BEGIN
  FOR stale IN
    SELECT run_id
    FROM content.acquisition_runs
    WHERE job_kind IS NULL
      AND status = 'RUNNING'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < now()
      AND run_metrics ->> 'controlPlaneProbe' = 'true'
    FOR UPDATE
  LOOP
    committed_units := 0;
    FOR reservation IN
      SELECT reservation_id, ledger_id, units
      FROM content.acquisition_budget_reservations
      WHERE run_id = stale.run_id
        AND status = 'RESERVED'
      FOR UPDATE
    LOOP
      IF reservation.units <= 0 THEN
        RAISE EXCEPTION 'control probe reservation has invalid units';
      END IF;
      UPDATE content.acquisition_budget_reservations
      SET status = 'COMMITTED', updated_at = now()
      WHERE reservation_id = reservation.reservation_id;
      UPDATE content.acquisition_budget_ledgers AS ledger
      SET reserved_units = ledger.reserved_units - reservation.units,
          committed_units = ledger.committed_units + reservation.units,
          updated_at = now()
      WHERE ledger.ledger_id = reservation.ledger_id;
      committed_units := committed_units + reservation.units;
    END LOOP;

    SELECT count(*) INTO trace_count
    FROM content.acquisition_provider_traces
    WHERE run_id = stale.run_id;
    IF committed_units > 0 AND trace_count = 0 THEN
      digest := md5(stale.run_id::text || ':control-probe-recovery');
      trace_uuid := (
        substr(digest, 1, 8) || '-' || substr(digest, 9, 4) || '-' ||
        substr(digest, 13, 4) || '-' || substr(digest, 17, 4) || '-' ||
        substr(digest, 21, 12)
      )::uuid;
      INSERT INTO content.acquisition_provider_traces (
        trace_id, run_id, sequence, provider, operation,
        request_metadata_hash, response_metadata_hash, provider_job_id_hash,
        provider_units, terminal_state
      )
      VALUES (
        trace_uuid, stale.run_id, 0, 'grok-build', 'x_user_search',
        current_setting('briefing.request_hash'), NULL, NULL,
        committed_units, 'CONTROL_PROBE_INTERRUPTED_UNKNOWN'
      );
    END IF;

    UPDATE content.acquisition_runs
    SET status = 'FAILED',
        provider = CASE WHEN committed_units > 0 THEN 'grok-build' ELSE NULL END,
        provider_units = CASE WHEN committed_units > 0 THEN committed_units ELSE NULL END,
        x_call_count = CASE WHEN committed_units > 0 THEN 1 ELSE 0 END,
        trace_verified = false,
        failure_class = 'CONTROL_PROBE_INTERRUPTED',
        error_summary = 'Control-plane probe lease expired before finalization; provider call state was unknown',
        failure_details_hash = current_setting('briefing.request_hash'),
        run_metrics = run_metrics || jsonb_build_object(
          'controlProbeRecovery', 'expired-lease',
          'providerProcessStartedUnknown', committed_units > 0
        ),
        completed_at = now(),
        lease_expires_at = null
    WHERE run_id = stale.run_id;
  END LOOP;
END
$recover$;

\o

INSERT INTO content.acquisition_runs (
  run_id, window_start, window_end, idempotency_key, status,
  request_snapshot, request_hash, source_snapshot, endpoint_snapshot,
  evidence_mode, run_metrics
)
VALUES (
  :'run_id'::uuid, now(), now(), :'idempotency_key', 'PENDING',
  '{"toolName":"x_user_search","input":{"query":"OfficialFPL","count":3}}'::jsonb,
  :'request_hash', '[]'::jsonb, '{}'::jsonb, 'PROVIDER_ATTESTED',
  '{"controlPlaneProbe":true,"probeTarget":"OfficialFPL"}'::jsonb
);

\o /dev/null
SELECT set_config('briefing.run_id', :'run_id', true);
SELECT set_config('briefing.reservation_id', :'reservation_id', true);
SELECT set_config('briefing.ledger_id', :'ledger_id', true);
SELECT set_config('briefing.daily_limit', :'daily_limit', true);
\o

DO $do$
DECLARE
  used_units numeric;
  ledger_id_value uuid;
BEGIN
  SELECT coalesce(sum(reservation.units), 0)
    INTO used_units
  FROM content.acquisition_budget_reservations AS reservation
  JOIN content.acquisition_budget_ledgers AS ledger
    ON ledger.ledger_id = reservation.ledger_id
  WHERE ledger.scope_kind = 'GLOBAL'
    AND ledger.scope_key = 'GROK_BUILD_X'
    AND ledger.unit_kind = 'CALL'
    AND reservation.status IN ('RESERVED', 'COMMITTED')
    AND reservation.created_at > now() - interval '24 hours';

  IF used_units + 1 > current_setting('briefing.daily_limit')::numeric THEN
    UPDATE content.acquisition_runs
    SET status = 'BUDGET_DEFERRED', completed_at = now(),
        error_summary = 'Control-plane probe deferred by global X call budget',
        run_metrics = run_metrics || jsonb_build_object(
          'deferredScope', 'GLOBAL:GROK_BUILD_X',
          'remainingBeforeReservation', greatest(0, current_setting('briefing.daily_limit')::numeric - used_units)
        )
    WHERE run_id = current_setting('briefing.run_id')::uuid;
    RETURN;
  END IF;

  INSERT INTO content.acquisition_budget_ledgers (
    ledger_id, scope_kind, scope_key, unit_kind,
    window_start, window_end, max_units
  )
  VALUES (
    current_setting('briefing.ledger_id')::uuid, 'GLOBAL', 'GROK_BUILD_X', 'CALL',
    date_trunc('hour', now()), date_trunc('hour', now()) + interval '1 hour',
    current_setting('briefing.daily_limit')::numeric
  )
  ON CONFLICT (scope_kind, scope_key, unit_kind, window_start, window_end)
  DO UPDATE SET
    max_units = greatest(
      content.acquisition_budget_ledgers.max_units,
      content.acquisition_budget_ledgers.reserved_units
        + content.acquisition_budget_ledgers.committed_units,
      excluded.max_units
    ),
    updated_at = now()
  RETURNING ledger_id INTO ledger_id_value;

  UPDATE content.acquisition_budget_ledgers
  SET reserved_units = reserved_units + 1, updated_at = now()
  WHERE ledger_id = ledger_id_value;

  INSERT INTO content.acquisition_budget_reservations (
    reservation_id, ledger_id, run_id, units, status
  )
  VALUES (
    current_setting('briefing.reservation_id')::uuid,
    ledger_id_value,
    current_setting('briefing.run_id')::uuid,
    1,
    'RESERVED'
  );

  UPDATE content.acquisition_runs
  SET status = 'RUNNING', started_at = now(),
      lease_expires_at = now() + interval '6 minutes'
  WHERE run_id = current_setting('briefing.run_id')::uuid;
END
$do$;

SELECT status FROM content.acquisition_runs WHERE run_id = :'run_id'::uuid;
COMMIT;
SQL
)

if [ "$reservation_state" = 'BUDGET_DEFERRED' ]; then
  printf '%s\n' '{"event":"briefing_control_probe_deferred","scope":"GLOBAL:GROK_BUILD_X"}'
  exit 75
fi
test "$reservation_state" = 'RUNNING'

body_file=$(mktemp)
cleanup() { rm -f -- "$body_file"; }
trap cleanup EXIT
http_code=$(curl --silent --show-error --max-time 90 --connect-timeout 5 \
  --unix-socket "$socket_path" \
  -X POST -H 'content-type: application/json' \
  --data '{"schemaVersion":1}' \
  -o "$body_file" -w '%{http_code}' \
  http://localhost/v1/probes/x || printf '000')
body=$(cat "$body_file")
response_hash=$(printf '%s' "$body" | sha256sum | awk '{print $1}')
provider_started=$(printf '%s' "$body" | jq -r 'if (.providerProcessStarted? == true) then "true" else "false" end' 2>/dev/null || printf 'false')
failure_class=$(printf '%s' "$body" | jq -r '.failureClass // empty' 2>/dev/null || true)

finalize_probe() {
  local terminal_state=$1
  local terminal_status=$2
  local commit_units=$3
  local failure_class_value=${4:-}
  local summary_value=${5:-}
  psql_exec \
    --set=run_id="$run_id" \
    --set=reservation_id="$reservation_id" \
    --set=trace_id="$trace_id" \
    --set=terminal_state="$terminal_state" \
    --set=terminal_status="$terminal_status" \
    --set=commit_units="$commit_units" \
    --set=failure_class="$failure_class_value" \
    --set=summary="$summary_value" \
    --set=response_hash="$response_hash" \
    --set=http_code="$http_code" <<'SQL'
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
\o /dev/null
SELECT pg_advisory_xact_lock(hashtext('briefing-x-budget-v1'));
SELECT set_config('briefing.run_id', :'run_id', true);
SELECT set_config('briefing.reservation_id', :'reservation_id', true);
SELECT set_config('briefing.trace_id', :'trace_id', true);
SELECT set_config('briefing.terminal_state', :'terminal_state', true);
SELECT set_config('briefing.terminal_status', :'terminal_status', true);
SELECT set_config('briefing.commit_units', :'commit_units', true);
SELECT set_config('briefing.failure_class', :'failure_class', true);
SELECT set_config('briefing.summary', :'summary', true);
SELECT set_config('briefing.response_hash', :'response_hash', true);
SELECT set_config('briefing.http_code', :'http_code', true);
\o

DO $do$
DECLARE
  ledger_id_value uuid;
BEGIN
  SELECT ledger_id INTO ledger_id_value
  FROM content.acquisition_budget_reservations
  WHERE reservation_id = current_setting('briefing.reservation_id')::uuid
    AND run_id = current_setting('briefing.run_id')::uuid
    AND status = 'RESERVED'
  FOR UPDATE;
  IF ledger_id_value IS NULL THEN
    RAISE EXCEPTION 'control probe reservation is not RESERVED';
  END IF;

  IF current_setting('briefing.commit_units') = '1' THEN
    UPDATE content.acquisition_budget_reservations
    SET status = 'COMMITTED', updated_at = now()
    WHERE reservation_id = current_setting('briefing.reservation_id')::uuid;
    UPDATE content.acquisition_budget_ledgers
    SET reserved_units = reserved_units - 1,
        committed_units = committed_units + 1,
        updated_at = now()
    WHERE ledger_id = ledger_id_value;
  ELSE
    UPDATE content.acquisition_budget_reservations
    SET status = 'RELEASED', updated_at = now()
    WHERE reservation_id = current_setting('briefing.reservation_id')::uuid;
    UPDATE content.acquisition_budget_ledgers
    SET reserved_units = reserved_units - 1, updated_at = now()
    WHERE ledger_id = ledger_id_value;
  END IF;

  IF current_setting('briefing.commit_units') = '1' THEN
    INSERT INTO content.acquisition_provider_traces (
      trace_id, run_id, sequence, provider, operation,
      request_metadata_hash, response_metadata_hash, provider_job_id_hash,
      provider_units, terminal_state
    )
    VALUES (
      current_setting('briefing.trace_id')::uuid, current_setting('briefing.run_id')::uuid, 0, 'grok-build', 'x_user_search',
      'abc5d750ecc73ec94b6d8c68411595f0ed83ba90d07342c3abc16b95133587bb',
      CASE WHEN current_setting('briefing.response_hash') ~ '^[0-9a-f]{64}$' THEN current_setting('briefing.response_hash') ELSE NULL END,
      NULL, 1, current_setting('briefing.terminal_state')
    );
  END IF;

  UPDATE content.acquisition_runs
  SET status = current_setting('briefing.terminal_status'),
      provider = 'grok-build',
      provider_units = CASE WHEN current_setting('briefing.commit_units') = '1' THEN 1 ELSE 0 END,
      x_call_count = CASE WHEN current_setting('briefing.commit_units') = '1' THEN 1 ELSE 0 END,
      trace_verified = false,
      failure_class = nullif(current_setting('briefing.failure_class'), ''),
      error_summary = nullif(current_setting('briefing.summary'), ''),
      failure_details_hash = CASE WHEN current_setting('briefing.summary') <> ''
        THEN current_setting('briefing.response_hash') ELSE NULL END,
      run_metrics = run_metrics || jsonb_build_object(
        'controlPlaneProbe', true,
        'probeTarget', 'OfficialFPL',
        'httpStatus', current_setting('briefing.http_code'),
        'responseMetadataHash', current_setting('briefing.response_hash')
      ),
      completed_at = now(), lease_expires_at = null
  WHERE run_id = current_setting('briefing.run_id')::uuid;
END
$do$;
COMMIT;
SQL
}

if [ "$http_code" = '200' ] && printf '%s' "$body" | jq -e '.ok == true and .toolName == "x_user_search"' >/dev/null 2>&1; then
  finalize_probe CONTROL_PLANE_PROBE COMPLETED 1
  printf '%s\n' "$body"
  exit 0
fi

if [ "$provider_started" = 'false' ] && {
  [ "$failure_class" = 'RUNNER_CAPACITY' ] ||
  [ "$failure_class" = 'RUNNER_PROBE_RATE_LIMITED' ];
}; then
  finalize_probe CONTROL_PLANE_PROBE_DEFERRED BUDGET_DEFERRED 0 "$failure_class" 'Host runner deferred the control-plane probe'
  printf '%s\n' '{"event":"briefing_control_probe_deferred","reason":"runner-capacity"}'
  exit 75
fi

if [ "$provider_started" = 'true' ] || [ "$http_code" = '000' ] || [ -z "$failure_class" ]; then
  finalize_probe CONTROL_PLANE_PROBE_UNKNOWN FAILED 1 "${failure_class:-RUNNER_TRANSPORT_UNKNOWN}" 'Host runner probe did not produce a successful response'
else
  finalize_probe CONTROL_PLANE_PROBE_REJECTED FAILED 0 "${failure_class:-RUNNER_PROBE_FAILED}" 'Host runner rejected the probe before provider start'
fi
printf '%s\n' "$body" >&2
exit 1
