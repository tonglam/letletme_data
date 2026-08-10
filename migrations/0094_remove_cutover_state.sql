-- Remove the completed cutover audit state. The operational migration ledger
-- remains authoritative; no business relation is touched by this migration.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_advisory_xact_lock(912883474);

DO $cutover_state_precondition$
DECLARE
  run_count bigint;
  total_evidence_count bigint;
  fixed_evidence_count bigint;
  graphql_evidence_count bigint;
  fixed_evidence_hash text;
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

  SELECT count(*) INTO total_evidence_count
  FROM ops.migration_objects
  WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
    AND status = 'passed'
    AND failed_count = 0;

  IF total_evidence_count <> (SELECT count(*) FROM ops.migration_objects) THEN
    RAISE EXCEPTION 'unexpected cutover evidence state';
  END IF;

  SELECT
    count(*),
    encode(
      sha256(
        convert_to(
          coalesce(
            string_agg(
              concat_ws(E'\t', check_name, source_object, target_object),
              E'\n'
              ORDER BY check_name, source_object, target_object
            ),
            ''
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO fixed_evidence_count, fixed_evidence_hash
  FROM ops.migration_objects
  WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
    AND check_name NOT LIKE 'legacy_graphql_migration:%';

  IF fixed_evidence_count <> 56
    OR fixed_evidence_hash <> '3703b54083ff4329685a2b7776e14aa4b6683786603760c326af59dde85d4c66'
  THEN
    RAISE EXCEPTION 'fixed cutover evidence identity does not match the accepted set';
  END IF;

  SELECT count(*) INTO graphql_evidence_count
  FROM ops.migration_objects
  WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
    AND check_name LIKE 'legacy_graphql_migration:%'
    AND source_object = 'public.graphql_schema_migrations'
    AND target_object = 'ops.migration_objects'
    AND source_row_count = 1
    AND target_row_count = 1
    AND source_hash IS NOT NULL
    AND source_hash = target_hash
    AND status = 'passed'
    AND failed_count = 0;

  IF graphql_evidence_count = 0
    OR total_evidence_count <> fixed_evidence_count + graphql_evidence_count
  THEN
    RAISE EXCEPTION 'dynamic GraphQL migration evidence is incomplete or contains unexpected rows';
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
