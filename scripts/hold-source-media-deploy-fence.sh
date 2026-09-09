#!/usr/bin/env bash

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

wait_seconds=${1:-300}
# A detached fence must have a finite lifetime.  The deploy shell checks the
# container at every database boundary and aborts closed if this lease expires.
hold_seconds=${2:-1500}
if ! [[ "$wait_seconds" =~ ^[1-9][0-9]*$ ]] || (( wait_seconds > 600 )); then
  echo 'Source-media deployment fence wait must be between 1 and 600 seconds' >&2
  exit 1
fi
if ! [[ "$hold_seconds" =~ ^[1-9][0-9]*$ ]] || (( hold_seconds > 1800 )); then
  echo 'Source-media deployment fence hold must be between 1 and 1800 seconds' >&2
  exit 1
fi
export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-5}

# The fence is also used by the first deployment after the source-media
# migration is introduced. There is nothing to fence until both target tables
# exist; let the migration create them instead of failing before it starts.
schema_state=$(psql "$DATABASE_URL" -X -qAt --set=ON_ERROR_STOP=1 -c \
  "SELECT CASE WHEN to_regclass('content.source_media_gates') IS NOT NULL AND to_regclass('content.source_media_assets') IS NOT NULL THEN 'present' ELSE 'absent' END")
case "$schema_state" in
  present) ;;
  absent)
    echo 'SOURCE_MEDIA_DEPLOY_FENCE_NOT_REQUIRED'
    exit 0
    ;;
  *)
    echo 'Could not determine whether source-media tables exist' >&2
    exit 1
    ;;
esac

psql "$DATABASE_URL" -X --set=ON_ERROR_STOP=1 <<SQL
BEGIN;
SET LOCAL lock_timeout = '0';
SET LOCAL statement_timeout = '0';
DO \$deploy_fence\$
DECLARE
  running_count integer;
  expiring_count integer;
  advisory_acquired boolean;
  wait_deadline timestamptz := clock_timestamp() + make_interval(secs => ${wait_seconds});
BEGIN
  LOOP
    -- Do this first without the deploy advisory so a live media worker can
    -- drain an overdue repair window. Taking the advisory before this check
    -- would make the worker return an empty claim forever.
    SELECT count(*) FILTER (
      WHERE status = 'RUNNING' AND lease_owner IS NOT NULL
    )::integer,
    count(*) FILTER (
      WHERE status IN ('PENDING', 'PARTIAL', 'UNAVAILABLE')
        AND repair_exhausted_at IS NULL
        AND repair_until_at <= clock_timestamp()
    )::integer
    INTO running_count, expiring_count
    FROM content.source_media_gates;

    IF running_count = 0 AND expiring_count = 0 THEN
      BEGIN
        advisory_acquired := false;
        SELECT pg_try_advisory_lock(hashtextextended('content-source-media-deploy-v1', 0))
        INTO advisory_acquired;
        IF NOT advisory_acquired THEN
          RAISE EXCEPTION 'SOURCE_MEDIA_DEPLOY_FENCE_RETRY';
        END IF;

        -- SHARE ROW EXCLUSIVE conflicts with legacy FOR UPDATE claims,
        -- retention leases, and new gate/asset inserts or updates. This table
        -- level fence covers rows inserted after the first scan and therefore
        -- closes the post-READY producer race without retaining row locks into
        -- schema migrations. It is released when the helper transaction ends.
        LOCK TABLE content.source_media_gates IN SHARE ROW EXCLUSIVE MODE NOWAIT;
        LOCK TABLE content.source_media_assets IN SHARE ROW EXCLUSIVE MODE NOWAIT;

        SELECT count(*) FILTER (
          WHERE status = 'RUNNING' AND lease_owner IS NOT NULL
        )::integer,
        count(*) FILTER (
          WHERE status IN ('PENDING', 'PARTIAL', 'UNAVAILABLE')
            AND repair_exhausted_at IS NULL
            AND repair_until_at <= clock_timestamp()
        )::integer
        INTO running_count, expiring_count
        FROM content.source_media_gates;
        IF running_count = 0 AND expiring_count = 0 THEN
          RAISE NOTICE 'SOURCE_MEDIA_DEPLOY_FENCE_READY';
          PERFORM pg_sleep(${hold_seconds});
          RETURN;
        END IF;
        RAISE EXCEPTION 'SOURCE_MEDIA_DEPLOY_FENCE_RETRY';
      EXCEPTION
        WHEN lock_not_available OR raise_exception THEN
          -- A legacy worker may still own a row/table lock, or a repair may
          -- have become due between the two scans. Release any advisory lock
          -- acquired in this attempt and let the media worker drain before
          -- trying the fenced hand-off again.
          IF advisory_acquired THEN
            PERFORM pg_advisory_unlock(
              hashtextextended('content-source-media-deploy-v1', 0)
            );
            advisory_acquired := false;
          END IF;
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
