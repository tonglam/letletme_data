#!/usr/bin/env bash

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

wait_seconds=${1:-300}
hold_seconds=${2:-0}
if ! [[ "$wait_seconds" =~ ^[1-9][0-9]*$ ]] || (( wait_seconds > 600 )); then
  echo 'Source-media deployment fence wait must be between 1 and 600 seconds' >&2
  exit 1
fi
if ! [[ "$hold_seconds" =~ ^[0-9]+$ ]] || (( hold_seconds > 600 )); then
  echo 'Source-media deployment fence hold must be between 0 and 600 seconds' >&2
  exit 1
fi
export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-5}

psql "$DATABASE_URL" -X --set=ON_ERROR_STOP=1 <<SQL
BEGIN;
SET LOCAL lock_timeout = '0';
SET LOCAL statement_timeout = '0';
DO \$advisory_fence\$
DECLARE
  advisory_acquired boolean;
  wait_deadline timestamptz := clock_timestamp() + make_interval(secs => ${wait_seconds});
BEGIN
  LOOP
    SELECT pg_try_advisory_lock(hashtextextended('content-source-media-deploy-v1', 0))
    INTO advisory_acquired;
    EXIT WHEN advisory_acquired;
    IF clock_timestamp() >= wait_deadline THEN
      RAISE EXCEPTION
        'Source-media deployment advisory fence did not become available within ${wait_seconds}s';
    END IF;
    PERFORM pg_sleep(1);
  END LOOP;
END
\$advisory_fence\$;
DO \$deploy_fence\$
DECLARE
  running_count integer;
  wait_deadline timestamptz := clock_timestamp() + make_interval(secs => ${wait_seconds});
BEGIN
  LOOP
    -- First let any already-running worker finish. The nested block below
    -- releases its row locks when a late claim is observed, then retries; once
    -- the post-lock count is zero the locks stay held for the whole fence.
    SELECT count(*) FILTER (
      WHERE status = 'RUNNING' AND lease_owner IS NOT NULL
    )::integer
    INTO running_count
    FROM content.source_media_gates;
    IF running_count = 0 THEN
      BEGIN
        PERFORM gate_id
        FROM content.source_media_gates
        WHERE status IN ('PENDING', 'PARTIAL', 'UNAVAILABLE', 'RUNNING')
          AND repair_exhausted_at IS NULL
        ORDER BY gate_id
        FOR UPDATE NOWAIT;

        SELECT count(*) FILTER (
          WHERE status = 'RUNNING' AND lease_owner IS NOT NULL
        )::integer
        INTO running_count
        FROM content.source_media_gates;
        IF running_count = 0 THEN
          RAISE NOTICE 'SOURCE_MEDIA_DEPLOY_FENCE_READY';
          IF ${hold_seconds} = 0 THEN
            -- Keep the transaction and its session-level advisory lock until
            -- the deploy shell removes this exact one-off container. A killed
            -- psql session rolls back and releases both locks automatically.
            LOOP
              PERFORM pg_sleep(5);
            END LOOP;
          ELSE
            PERFORM pg_sleep(${hold_seconds});
          END IF;
          RETURN;
        END IF;
      EXCEPTION
        WHEN lock_not_available THEN
          -- A legacy worker can still hold a row lock because it predates the
          -- advisory check. Release any locks acquired in this nested block,
          -- then retry until the bounded wait deadline.
          NULL;
      END;
    END IF;
    IF clock_timestamp() >= wait_deadline THEN
      RAISE EXCEPTION
        'Source-media deployment fence did not become idle within ${wait_seconds}s';
    END IF;
    PERFORM pg_sleep(2);
  END LOOP;
END
\$deploy_fence\$;
ROLLBACK;
SQL
