#!/usr/bin/env bash

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

wait_seconds=${1:-300}
hold_seconds=${2:-60}
if ! [[ "$wait_seconds" =~ ^[1-9][0-9]*$ ]] || (( wait_seconds > 600 )); then
  echo 'Source-media deployment fence wait must be between 1 and 600 seconds' >&2
  exit 1
fi
if ! [[ "$hold_seconds" =~ ^[1-9][0-9]*$ ]] || (( hold_seconds > 60 )); then
  echo 'Source-media deployment fence hold must be between 1 and 60 seconds' >&2
  exit 1
fi
statement_timeout_seconds=$((wait_seconds + hold_seconds + 15))
export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-5}

psql "$DATABASE_URL" -X --set=ON_ERROR_STOP=1 <<SQL
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '${statement_timeout_seconds}s';
DO \$deploy_fence\$
DECLARE
  running_count integer;
  expiring_count integer;
  wait_deadline timestamptz := clock_timestamp() + make_interval(secs => ${wait_seconds});
BEGIN
  LOOP
    BEGIN
      PERFORM gate_id
      FROM content.source_media_gates
      WHERE status IN ('PENDING', 'PARTIAL', 'UNAVAILABLE', 'RUNNING')
        AND repair_exhausted_at IS NULL
      ORDER BY gate_id
      FOR UPDATE;

      SELECT
        count(*) FILTER (
          WHERE status = 'RUNNING'
        )::integer,
        count(*) FILTER (
          WHERE status IN ('PENDING', 'PARTIAL', 'UNAVAILABLE')
            AND repair_exhausted_at IS NULL
            AND repair_until_at <= clock_timestamp()
        )::integer
      INTO running_count, expiring_count
      FROM content.source_media_gates;

      IF running_count <> 0 OR expiring_count <> 0 THEN
        RAISE EXCEPTION 'SOURCE_MEDIA_DEPLOY_FENCE_BUSY';
      END IF;

      RAISE NOTICE 'SOURCE_MEDIA_DEPLOY_FENCE_READY';
      PERFORM pg_sleep(${hold_seconds});
      RETURN;
    EXCEPTION
      WHEN lock_not_available OR raise_exception THEN
        IF clock_timestamp() >= wait_deadline THEN
          RAISE EXCEPTION
            'Source-media deployment fence did not become idle within ${wait_seconds}s';
        END IF;
        PERFORM pg_sleep(2);
    END;
  END LOOP;
END
\$deploy_fence\$;
ROLLBACK;
SQL
