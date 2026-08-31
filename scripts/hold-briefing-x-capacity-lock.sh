#!/usr/bin/env bash

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

# Keep this session-level lock only for the bounded pre-migration drain.  The
# deployment shell owns the exact container and stops it before migrations;
# the sleep is a second safety fence for an interrupted SSH/deploy process.
# This is deliberately a lock-only operation: it does not mutate business
# rows, Redis state, or acquisition leases.
exec psql "$DATABASE_URL" -X -qAt --set=ON_ERROR_STOP=1 <<'SQL'
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SELECT pg_advisory_lock(hashtext('briefing-x-capacity-v1'));
SELECT 'deploy_x_capacity_lock_ready';
SELECT pg_sleep(900);
SQL
