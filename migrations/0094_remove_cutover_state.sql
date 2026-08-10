-- Remove the completed cutover audit state. The operational migration ledger
-- remains authoritative; no business relation is touched by this migration.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_advisory_xact_lock(912883474);

DO $cutover_state_precondition$
DECLARE
  run_count bigint;
  evidence_count bigint;
BEGIN
  IF to_regclass('ops.migration_runs') IS NULL
    OR to_regclass('ops.migration_objects') IS NULL THEN
    RAISE EXCEPTION 'cutover audit tables are not both present';
  END IF;

  SELECT count(*) INTO run_count
  FROM ops.migration_runs
  WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
    AND status = 'activated'
    AND metadata ->> 'legacyDropPhase' = 'complete';

  IF run_count <> 1 OR (SELECT count(*) FROM ops.migration_runs) <> 1 THEN
    RAISE EXCEPTION 'unexpected cutover run state';
  END IF;

  SELECT count(*) INTO evidence_count
  FROM ops.migration_objects
  WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
    AND status = 'passed'
    AND failed_count = 0;

  IF evidence_count <> 61 OR (SELECT count(*) FROM ops.migration_objects) <> 61 THEN
    RAISE EXCEPTION 'unexpected cutover evidence state';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'letletme_v2_frozen_owner'
      AND NOT rolcanlogin
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolinherit
      AND NOT rolreplication
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'temporary frozen owner is missing or has unsafe attributes';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = 'letletme_v2_frozen_owner'
       OR member_role.rolname = 'letletme_v2_frozen_owner'
  ) THEN
    RAISE EXCEPTION 'temporary frozen owner still has role memberships';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_shdepend dependency
    JOIN pg_roles role_row ON role_row.oid = dependency.refobjid
    WHERE role_row.rolname = 'letletme_v2_frozen_owner'
  ) THEN
    RAISE EXCEPTION 'temporary frozen owner still has shared dependencies';
  END IF;
END
$cutover_state_precondition$;

SET LOCAL ROLE letletme_data_owner;

DROP TABLE ops.migration_objects RESTRICT;
DROP TABLE ops.migration_runs RESTRICT;

RESET ROLE;

DROP ROLE letletme_v2_frozen_owner;

DO $cutover_state_postcondition$
BEGIN
  IF to_regclass('ops.migration_runs') IS NOT NULL
    OR to_regclass('ops.migration_objects') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'letletme_v2_frozen_owner') THEN
    RAISE EXCEPTION 'cutover state removal did not complete';
  END IF;
END
$cutover_state_postcondition$;
