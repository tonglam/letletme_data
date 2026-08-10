-- Atomically activate the first v3 core revision and freeze the complete,
-- P0-approved v2 public-schema object set. No legacy object is dropped here.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

SELECT pg_advisory_xact_lock(912883472);

DO $activation_preflight$
DECLARE
  failed_check_count bigint;
  invalid_constraint_count bigint;
  prepared_publication_count bigint;
  run_status text;
BEGIN
  SELECT status INTO run_status
  FROM ops.migration_runs
  WHERE run_id = 'v3-20260808T160008Z-b9eddc0';

  IF run_status IS DISTINCT FROM 'validated' THEN
    RAISE EXCEPTION 'v3 migration run must be validated before activation, found %', run_status;
  END IF;

  SELECT count(*) INTO failed_check_count
  FROM ops.migration_objects
  WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
    AND status = 'failed';

  IF failed_check_count <> 0 THEN
    RAISE EXCEPTION 'v3 migration run has % failed checks', failed_check_count;
  END IF;

  SELECT count(*) INTO invalid_constraint_count
  FROM pg_constraint constraint_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = constraint_row.connamespace
  WHERE namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops')
    AND NOT constraint_row.convalidated;

  IF invalid_constraint_count <> 0 THEN
    RAISE EXCEPTION 'v3 schemas contain % unvalidated constraints', invalid_constraint_count;
  END IF;

  SELECT count(*) INTO prepared_publication_count
  FROM ops.dataset_publications publication
  JOIN fpl.seasons season ON season.season_id = publication.season_id AND season.is_current
  WHERE publication.dataset = 'fpl:core'
    AND publication.event_id IS NULL
    AND publication.status = 'staging'
    AND publication.manifest ->> 'schemaVersion' = 'v3'
    AND publication.manifest ->> 'planVersion' = '3.1.1'
    AND publication.manifest ->> 'state' = 'prepared';

  IF prepared_publication_count <> 1 THEN
    RAISE EXCEPTION 'expected one prepared current v3 core publication, found %',
      prepared_publication_count;
  END IF;
END
$activation_preflight$;

CREATE TEMPORARY TABLE v3_legacy_physical_relations (
  relation_name name PRIMARY KEY
) ON COMMIT DROP;

WITH families(relation_name) AS (
  VALUES
    ('event_fixtures'),
    ('event_live_explains'),
    ('event_live_summaries'),
    ('event_lives'),
    ('events'),
    ('fpl_player_fixture_stats'),
    ('phases'),
    ('player_market_snapshots'),
    ('player_stats'),
    ('player_values'),
    ('players'),
    ('teams')
), seasons(season_code) AS (
  VALUES
    ('1617'), ('1718'), ('1819'), ('1920'), ('2021'), ('2122'),
    ('2223'), ('2324'), ('2425'), ('2526'), ('2627')
)
INSERT INTO v3_legacy_physical_relations (relation_name)
SELECT relation_name::name FROM families
UNION ALL
SELECT (relation_name || '_history')::name FROM families
UNION ALL
SELECT (relation_name || '_' || season_code)::name FROM families CROSS JOIN seasons;

INSERT INTO v3_legacy_physical_relations (relation_name)
VALUES
  ('core_snapshot_authority'),
  ('entry_event_cup_results'),
  ('entry_event_picks'),
  ('entry_event_results'),
  ('entry_event_transfers'),
  ('entry_history_infos'),
  ('entry_infos'),
  ('entry_league_infos'),
  ('fpl_season_archive_items'),
  ('fpl_season_archives'),
  ('graphql_schema_migrations'),
  ('league_event_results'),
  ('provider_entity_aliases'),
  ('provider_entity_links'),
  ('provider_match_links'),
  ('sql_migrations'),
  ('tournament_battle_group_results'),
  ('tournament_entries'),
  ('tournament_groups'),
  ('tournament_infos'),
  ('tournament_knockout_results'),
  ('tournament_knockouts'),
  ('tournament_points_group_results'),
  ('tournament_selection_stats'),
  ('understat_matches'),
  ('understat_player_match_stats'),
  ('understat_player_seasons'),
  ('understat_player_team_seasons'),
  ('understat_players'),
  ('understat_seasons'),
  ('understat_sync_items'),
  ('understat_sync_runs'),
  ('understat_team_match_stats'),
  ('understat_team_seasons'),
  ('understat_team_stat_splits'),
  ('understat_teams');

-- GraphQL mainline may have introduced this catalog after the original P0
-- inventory was captured. Treat it as an optional v2 source and freeze it
-- with the rest of public when present; 0090_zz copies it into competition.
INSERT INTO v3_legacy_physical_relations (relation_name)
SELECT 'public_league_trends_catalog'::name
WHERE to_regclass('public.public_league_trends_catalog') IS NOT NULL;

-- Later evidence writes run as the data owner. Permit that role to read this
-- transaction-local manifest without broadening access to any public object.
GRANT SELECT ON v3_legacy_physical_relations TO letletme_data_owner;

CREATE TEMPORARY TABLE v3_legacy_read_relations (
  relation_name name PRIMARY KEY,
  relation_kind "char" NOT NULL
) ON COMMIT DROP;

INSERT INTO v3_legacy_read_relations (relation_name, relation_kind)
VALUES
  ('mv_tournament_event_snapshot', 'm'),
  ('mv_tournament_snapshot', 'm'),
  ('v_tournament_event_result', 'v'),
  ('v_tournament_event_snapshot', 'v'),
  ('v_tournament_selection_stats', 'v'),
  ('v_tournament_snapshot', 'v');

CREATE TEMPORARY TABLE v3_legacy_sequences (
  relation_name name PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO v3_legacy_sequences (relation_name)
VALUES
  ('core_snapshot_revision_seq'),
  ('entry_event_cup_results_id_seq'),
  ('entry_event_picks_id_seq'),
  ('entry_event_results_id_seq'),
  ('entry_event_transfers_id_seq'),
  ('entry_history_infos_id_seq'),
  ('entry_league_infos_id_seq'),
  ('event_live_explains_id_seq'),
  ('event_live_summaries_id_seq'),
  ('event_lives_id_seq'),
  ('fpl_player_fixture_stats_id_seq'),
  ('league_event_results_id_seq'),
  ('player_market_snapshots_id_seq'),
  ('player_stats_id_seq'),
  ('player_values_id_seq'),
  ('tournament_battle_group_results_id_seq'),
  ('tournament_entries_id_seq'),
  ('tournament_groups_id_seq'),
  ('tournament_infos_id_seq'),
  ('tournament_knockout_results_id_seq'),
  ('tournament_knockouts_id_seq'),
  ('tournament_points_group_results_id_seq');

DO $legacy_scope_contract$
DECLARE
  column_acl_count bigint;
  missing_physical text;
  missing_read text;
  missing_sequence text;
  unexpected_physical text;
  unexpected_enum_owner text;
  unexpected_function_owner text;
  unexpected_relation_owner text;
  unexpected_read text;
  unexpected_sequence text;
BEGIN
  SELECT string_agg(relation_row.relname, ', ' ORDER BY relation_row.relname)
  INTO unexpected_relation_owner
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
    AND relation_row.relowner <> (SELECT oid FROM pg_roles WHERE rolname = session_user);

  SELECT string_agg(
    function_row.proname || '(' || pg_get_function_identity_arguments(function_row.oid) || ')',
    ', ' ORDER BY function_row.proname, pg_get_function_identity_arguments(function_row.oid)
  )
  INTO unexpected_function_owner
  FROM pg_proc function_row
  WHERE function_row.pronamespace = 'public'::regnamespace
    AND function_row.proowner <> (SELECT oid FROM pg_roles WHERE rolname = session_user);

  SELECT string_agg(type_row.typname, ', ' ORDER BY type_row.typname)
  INTO unexpected_enum_owner
  FROM pg_type type_row
  WHERE type_row.typnamespace = 'public'::regnamespace
    AND type_row.typtype = 'e'
    AND type_row.typowner <> (SELECT oid FROM pg_roles WHERE rolname = session_user);

  IF unexpected_relation_owner IS NOT NULL
     OR unexpected_function_owner IS NOT NULL
     OR unexpected_enum_owner IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'v2 ownership differs from the production cutover contract',
      DETAIL = format(
        'relations/sequences=[%s]; functions=[%s]; enums=[%s]; expected owner=%s',
        COALESCE(unexpected_relation_owner, ''),
        COALESCE(unexpected_function_owner, ''),
        COALESCE(unexpected_enum_owner, ''),
        session_user
      );
  END IF;

  SELECT string_agg(relation_name::text, ', ' ORDER BY relation_name)
  INTO missing_physical
  FROM (
    SELECT expected.relation_name
    FROM v3_legacy_physical_relations expected
    LEFT JOIN pg_class relation_row
      ON relation_row.relname = expected.relation_name
     AND relation_row.relnamespace = 'public'::regnamespace
     AND relation_row.relkind IN ('r', 'p')
    WHERE relation_row.oid IS NULL
    ORDER BY expected.relation_name
    LIMIT 10
  ) missing;

  SELECT string_agg(relname, ', ' ORDER BY relname)
  INTO unexpected_physical
  FROM (
    SELECT relation_row.relname
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p')
      AND NOT EXISTS (
        SELECT 1
        FROM v3_legacy_physical_relations expected
        WHERE expected.relation_name = relation_row.relname
      )
    ORDER BY relation_row.relname
    LIMIT 10
  ) unexpected;

  SELECT string_agg(relation_name::text, ', ' ORDER BY relation_name)
  INTO missing_read
  FROM (
    SELECT expected.relation_name
    FROM v3_legacy_read_relations expected
    LEFT JOIN pg_class relation_row
      ON relation_row.relname = expected.relation_name
     AND relation_row.relnamespace = 'public'::regnamespace
     AND relation_row.relkind = expected.relation_kind
    WHERE relation_row.oid IS NULL
    ORDER BY expected.relation_name
    LIMIT 10
  ) missing;

  SELECT string_agg(relname, ', ' ORDER BY relname)
  INTO unexpected_read
  FROM (
    SELECT relation_row.relname
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('m', 'v')
      AND NOT EXISTS (
        SELECT 1
        FROM v3_legacy_read_relations expected
        WHERE expected.relation_name = relation_row.relname
          AND expected.relation_kind = relation_row.relkind
      )
    ORDER BY relation_row.relname
    LIMIT 10
  ) unexpected;

  SELECT string_agg(relation_name::text, ', ' ORDER BY relation_name)
  INTO missing_sequence
  FROM (
    SELECT expected.relation_name
    FROM v3_legacy_sequences expected
    LEFT JOIN pg_class relation_row
      ON relation_row.relname = expected.relation_name
     AND relation_row.relnamespace = 'public'::regnamespace
     AND relation_row.relkind = 'S'
    WHERE relation_row.oid IS NULL
    ORDER BY expected.relation_name
    LIMIT 10
  ) missing;

  SELECT string_agg(relname, ', ' ORDER BY relname)
  INTO unexpected_sequence
  FROM (
    SELECT relation_row.relname
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind = 'S'
      AND NOT EXISTS (
        SELECT 1
        FROM v3_legacy_sequences expected
        WHERE expected.relation_name = relation_row.relname
      )
    ORDER BY relation_row.relname
    LIMIT 10
  ) unexpected;

  SELECT count(*) INTO column_acl_count
  FROM pg_attribute attribute_row
  JOIN pg_class relation_row ON relation_row.oid = attribute_row.attrelid
  CROSS JOIN LATERAL aclexplode(attribute_row.attacl) acl_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p', 'm', 'v')
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped
    AND acl_row.grantee <> relation_row.relowner;

  IF missing_physical IS NOT NULL OR unexpected_physical IS NOT NULL
     OR missing_read IS NOT NULL OR unexpected_read IS NOT NULL
     OR missing_sequence IS NOT NULL OR unexpected_sequence IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'public v2 object scope differs from the P0-approved inventory',
      DETAIL = format(
        'missing physical=[%s]; unexpected physical=[%s]; missing read=[%s]; '
        'unexpected read=[%s]; missing sequences=[%s]; unexpected sequences=[%s]',
        COALESCE(missing_physical, ''),
        COALESCE(unexpected_physical, ''),
        COALESCE(missing_read, ''),
        COALESCE(unexpected_read, ''),
        COALESCE(missing_sequence, ''),
        COALESCE(unexpected_sequence, '')
      );
  END IF;

  IF (SELECT count(*) FROM v3_legacy_physical_relations) < 192
     OR (SELECT count(*) FROM v3_legacy_physical_relations) > 193
     OR (SELECT count(*) FROM v3_legacy_read_relations) <> 6
     OR (SELECT count(*) FROM v3_legacy_sequences) <> 22 THEN
    RAISE EXCEPTION 'internal v2 freeze manifest count mismatch';
  END IF;

  IF column_acl_count <> 0 THEN
    RAISE EXCEPTION 'unexpected non-owner column ACLs on v2 relations: %', column_acl_count;
  END IF;
END
$legacy_scope_contract$;

DO $legacy_ledger_contract$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.sql_migrations
    WHERE checksum IS NULL OR checksum !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'public.sql_migrations contains a missing or invalid checksum';
  END IF;
END
$legacy_ledger_contract$;

SET LOCAL ROLE letletme_data_owner;

INSERT INTO ops.schema_migrations (filename, checksum, applied_at)
SELECT filename, checksum, applied_at
FROM public.sql_migrations
ON CONFLICT (filename) DO UPDATE SET
  checksum = EXCLUDED.checksum,
  applied_at = EXCLUDED.applied_at;

RESET ROLE;

DO $ledger_reconciliation$
DECLARE
  difference_count bigint;
BEGIN
  SELECT count(*) INTO difference_count
  FROM (
    SELECT
      COALESCE(legacy.filename, target.filename) AS filename,
      legacy.checksum AS legacy_checksum,
      target.checksum AS target_checksum,
      legacy.applied_at AS legacy_applied_at,
      target.applied_at AS target_applied_at
    FROM public.sql_migrations legacy
    FULL JOIN ops.schema_migrations target USING (filename)
    WHERE legacy.filename IS NULL
       OR target.filename IS NULL
       OR legacy.checksum IS DISTINCT FROM target.checksum
       OR legacy.applied_at IS DISTINCT FROM target.applied_at
  ) differences;

  IF difference_count <> 0 THEN
    RAISE EXCEPTION 'legacy and v3 migration ledgers differ in % rows', difference_count;
  END IF;
END
$ledger_reconciliation$;

SET LOCAL ROLE letletme_data_owner;

CREATE OR REPLACE FUNCTION ops.reject_v2_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, ops
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format(
      'v2 relation %I.%I is frozen after Data Platform v3 activation',
      TG_TABLE_SCHEMA,
      TG_TABLE_NAME
    ),
    HINT = 'Write through the schema-qualified v3 Data contract.';
END
$function$;

ALTER FUNCTION ops.reject_v2_mutation() OWNER TO letletme_data_owner;
REVOKE ALL ON FUNCTION ops.reject_v2_mutation() FROM PUBLIC;

RESET ROLE;

ALTER TABLE public.sql_migrations RENAME TO sql_migrations_v2;

UPDATE v3_legacy_physical_relations
SET relation_name = 'sql_migrations_v2'
WHERE relation_name = 'sql_migrations';

-- PostgreSQL requires a relation's new owner to have CREATE on its schema.
-- Supabase's secure fresh baseline does not grant that privilege on public,
-- so grant it only for this compatibility-view ownership handoff.
GRANT CREATE ON SCHEMA public TO letletme_data_owner;

CREATE VIEW public.sql_migrations
WITH (security_invoker = true)
AS
SELECT filename, checksum, applied_at
FROM ops.schema_migrations;

REVOKE ALL ON TABLE public.sql_migrations FROM PUBLIC;

DO $compatibility_ledger_grant$
BEGIN
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON TABLE public.sql_migrations TO %I',
    session_user
  );
END
$compatibility_ledger_grant$;

ALTER VIEW public.sql_migrations OWNER TO letletme_data_owner;

REVOKE CREATE ON SCHEMA public FROM letletme_data_owner;

DO $assume_v2_frozen_owner$
BEGIN
  IF NOT pg_has_role(session_user, 'letletme_v2_frozen_owner', 'MEMBER') THEN
    EXECUTE format('GRANT letletme_v2_frozen_owner TO %I', session_user);
  END IF;
END
$assume_v2_frozen_owner$;

-- The source relations are owned by postgres in production. ACL revocation
-- alone cannot remove an owner's implicit read/write/DDL privileges, so move
-- the complete P0-approved legacy surface to a temporary NOLOGIN owner. The
-- migration login's membership is revoked after trigger and ACL installation.
GRANT CREATE ON SCHEMA public TO letletme_v2_frozen_owner;

DO $transfer_v2_relation_ownership$
DECLARE
  relation_record record;
  alter_kind text;
BEGIN
  FOR relation_record IN
    SELECT relation_row.relname, relation_row.relkind
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND (
        EXISTS (
          SELECT 1
          FROM v3_legacy_physical_relations expected
          WHERE expected.relation_name = relation_row.relname
            AND relation_row.relkind IN ('r', 'p')
        )
        OR EXISTS (
          SELECT 1
          FROM v3_legacy_read_relations expected
          WHERE expected.relation_name = relation_row.relname
            AND expected.relation_kind = relation_row.relkind
        )
      )
    ORDER BY relation_row.relkind, relation_row.relname
  LOOP
    alter_kind := CASE relation_record.relkind
      WHEN 'm' THEN 'MATERIALIZED VIEW'
      WHEN 'v' THEN 'VIEW'
      ELSE 'TABLE'
    END;
    EXECUTE format(
      'ALTER %s public.%I OWNER TO letletme_v2_frozen_owner',
      alter_kind,
      relation_record.relname
    );
  END LOOP;
END
$transfer_v2_relation_ownership$;

DO $transfer_v2_sequence_ownership$
DECLARE
  sequence_record record;
BEGIN
  FOR sequence_record IN
    SELECT relation_row.relname
    FROM pg_class relation_row
    JOIN v3_legacy_sequences expected ON expected.relation_name = relation_row.relname
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind = 'S'
    ORDER BY relation_row.relname
  LOOP
    EXECUTE format(
      'ALTER SEQUENCE public.%I OWNER TO letletme_v2_frozen_owner',
      sequence_record.relname
    );
  END LOOP;
END
$transfer_v2_sequence_ownership$;

DO $transfer_v2_function_ownership$
DECLARE
  function_record record;
BEGIN
  FOR function_record IN
    SELECT function_row.oid
    FROM pg_proc function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
    ORDER BY function_row.oid::regprocedure::text
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s OWNER TO letletme_v2_frozen_owner',
      function_record.oid::regprocedure
    );
  END LOOP;
END
$transfer_v2_function_ownership$;

DO $transfer_v2_enum_ownership$
DECLARE
  type_record record;
BEGIN
  FOR type_record IN
    SELECT type_row.typname
    FROM pg_type type_row
    WHERE type_row.typnamespace = 'public'::regnamespace
      AND type_row.typtype = 'e'
    ORDER BY type_row.typname
  LOOP
    EXECUTE format(
      'ALTER TYPE public.%I OWNER TO letletme_v2_frozen_owner',
      type_record.typname
    );
  END LOOP;
END
$transfer_v2_enum_ownership$;

DO $install_v2_write_fence$
DECLARE
  relation_record record;
BEGIN
  FOR relation_record IN
    SELECT relation_row.oid, relation_row.relname, relation_row.relkind
    FROM pg_class relation_row
    JOIN v3_legacy_physical_relations expected
      ON expected.relation_name = relation_row.relname
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p')
    ORDER BY CASE relation_row.relkind WHEN 'p' THEN 0 ELSE 1 END, relation_row.relname
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_row
      WHERE trigger_row.tgrelid = relation_record.oid
        AND trigger_row.tgname = 'v3_reject_v2_mutation'
        AND NOT trigger_row.tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER v3_reject_v2_mutation '
        'BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
        'FOR EACH STATEMENT EXECUTE FUNCTION ops.reject_v2_mutation()',
        relation_record.relname
      );
    END IF;
  END LOOP;
END
$install_v2_write_fence$;

DO $revoke_v2_relation_access$
DECLARE
  grantee_record record;
  relation_record record;
BEGIN
  FOR relation_record IN
    SELECT relation_row.oid, relation_row.relname, relation_row.relowner
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND (
        EXISTS (
          SELECT 1
          FROM v3_legacy_physical_relations expected
          WHERE expected.relation_name = relation_row.relname
            AND relation_row.relkind IN ('r', 'p')
        )
        OR EXISTS (
          SELECT 1
          FROM v3_legacy_read_relations expected
          WHERE expected.relation_name = relation_row.relname
            AND expected.relation_kind = relation_row.relkind
        )
      )
    ORDER BY relation_row.relname
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC',
      relation_record.relname
    );

    FOR grantee_record IN
      SELECT DISTINCT acl_row.grantee, pg_get_userbyid(acl_row.grantee) AS role_name
      FROM pg_class acl_relation
      CROSS JOIN LATERAL aclexplode(acl_relation.relacl) acl_row
      WHERE acl_relation.oid = relation_record.oid
        AND acl_row.grantee <> 0
        AND acl_row.grantee <> relation_record.relowner
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
        relation_record.relname,
        grantee_record.role_name
      );
    END LOOP;
  END LOOP;
END
$revoke_v2_relation_access$;

DO $revoke_v2_sequence_access$
DECLARE
  grantee_record record;
  sequence_record record;
BEGIN
  FOR sequence_record IN
    SELECT relation_row.oid, relation_row.relname, relation_row.relowner
    FROM pg_class relation_row
    JOIN v3_legacy_sequences expected ON expected.relation_name = relation_row.relname
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind = 'S'
    ORDER BY relation_row.relname
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM PUBLIC',
      sequence_record.relname
    );

    FOR grantee_record IN
      SELECT DISTINCT acl_row.grantee, pg_get_userbyid(acl_row.grantee) AS role_name
      FROM pg_class acl_relation
      CROSS JOIN LATERAL aclexplode(acl_relation.relacl) acl_row
      WHERE acl_relation.oid = sequence_record.oid
        AND acl_row.grantee <> 0
        AND acl_row.grantee <> sequence_record.relowner
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM %I',
        sequence_record.relname,
        grantee_record.role_name
      );
    END LOOP;
  END LOOP;
END
$revoke_v2_sequence_access$;

REVOKE CREATE ON SCHEMA public FROM letletme_v2_frozen_owner;

DO $release_v2_frozen_owner$
BEGIN
  -- pg_has_role() is always true for a superuser, even without a membership
  -- edge. Revoke only a real grant; the postcondition below separately checks
  -- inherited membership for non-superuser migration logins.
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    WHERE member_role.rolname = session_user
      AND granted_role.rolname = 'letletme_v2_frozen_owner'
  ) THEN
    EXECUTE format('REVOKE letletme_v2_frozen_owner FROM %I', session_user);
  END IF;
END
$release_v2_frozen_owner$;

ALTER ROLE letletme_data_owner NOBYPASSRLS;

SET LOCAL ROLE letletme_data_owner;

DO $activate_publication$
DECLARE
  candidate_publication_id uuid;
  candidate_count bigint;
  current_season_id smallint;
BEGIN
  SELECT season_id INTO STRICT current_season_id
  FROM fpl.seasons
  WHERE is_current;

  PERFORM 1
  FROM ops.dataset_publications
  WHERE dataset = 'fpl:core'
    AND season_id = current_season_id
    AND event_id IS NULL
  FOR UPDATE;

  SELECT count(*), min(publication_id::text)::uuid
  INTO candidate_count, candidate_publication_id
  FROM ops.dataset_publications
  WHERE dataset = 'fpl:core'
    AND season_id = current_season_id
    AND event_id IS NULL
    AND status = 'staging'
    AND manifest ->> 'schemaVersion' = 'v3'
    AND manifest ->> 'planVersion' = '3.1.1'
    AND manifest ->> 'state' = 'prepared';

  IF candidate_count <> 1 THEN
    RAISE EXCEPTION 'expected one locked v3 core activation candidate, found %', candidate_count;
  END IF;

  UPDATE ops.dataset_publications
  SET
    status = 'retired',
    retired_at = now(),
    updated_at = now(),
    manifest = jsonb_set(manifest, '{state}', '"retired"'::jsonb, true)
  WHERE dataset = 'fpl:core'
    AND season_id = current_season_id
    AND event_id IS NULL
    AND status = 'active'
    AND publication_id <> candidate_publication_id;

  UPDATE ops.dataset_publications
  SET
    status = 'active',
    activated_at = now(),
    retired_at = NULL,
    updated_at = now(),
    manifest = jsonb_set(manifest, '{state}', '"active"'::jsonb, true)
  WHERE publication_id = candidate_publication_id
    AND status = 'staging';

  IF (SELECT count(*) FROM ops.dataset_publications
      WHERE dataset = 'fpl:core'
        AND season_id = current_season_id
        AND event_id IS NULL
        AND status = 'active'
        AND manifest ->> 'schemaVersion' = 'v3'
        AND manifest ->> 'state' = 'active') <> 1 THEN
    RAISE EXCEPTION 'v3 core publication activation invariant failed';
  END IF;
END
$activate_publication$;

UPDATE ops.migration_runs
SET
  status = 'activated',
  completed_at = now(),
  updated_at = now(),
  metadata = metadata || jsonb_build_object(
    'activatedPlanVersion', '3.1.1',
    'v2PhysicalRelationCount', (SELECT count(*) FROM v3_legacy_physical_relations),
    'v2ReadRelationCount', 6,
    'v2SequenceCount', 22,
    'v2FreezeState', 'trigger_and_acl_fenced'
  )
WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
  AND status = 'validated';

INSERT INTO ops.migration_objects (
  run_id,
  check_name,
  source_object,
  target_object,
  query_sha256,
  source_row_count,
  target_row_count,
  source_hash,
  target_hash,
  failed_count,
  sample_failed_keys,
  status
)
SELECT
  run.run_id,
  '0090_activate_v3_and_freeze_v2',
  'public v2 physical relations',
  'ops.dataset_publications + v2 mutation fences',
  encode(sha256(convert_to('0090_activate_v3_and_freeze_v2_v2', 'UTF8')), 'hex'),
  (SELECT count(*) FROM v3_legacy_physical_relations),
  (
    SELECT count(*)
    FROM pg_trigger trigger_row
    JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND trigger_row.tgname = 'v3_reject_v2_mutation'
      AND trigger_row.tgfoid = 'ops.reject_v2_mutation()'::regprocedure
      AND NOT trigger_row.tgisinternal
  ),
  NULL,
  NULL,
  0,
  '[]'::jsonb,
  'passed'
FROM ops.migration_runs run
WHERE run.run_id = 'v3-20260808T160008Z-b9eddc0'
ON CONFLICT (run_id, check_name, source_object, target_object) DO UPDATE SET
  query_sha256 = EXCLUDED.query_sha256,
  source_row_count = EXCLUDED.source_row_count,
  target_row_count = EXCLUDED.target_row_count,
  failed_count = EXCLUDED.failed_count,
  sample_failed_keys = EXCLUDED.sample_failed_keys,
  status = EXCLUDED.status,
  executed_at = now();

RESET ROLE;

DO $activation_postconditions$
DECLARE
  active_publication_count bigint;
  nonowner_relation_acl_count bigint;
  nonowner_sequence_acl_count bigint;
  trigger_count bigint;
  unexpected_owner_count bigint;
BEGIN
  SELECT count(*) INTO trigger_count
  FROM pg_trigger trigger_row
  JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
  JOIN v3_legacy_physical_relations expected ON expected.relation_name = relation_row.relname
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND trigger_row.tgname = 'v3_reject_v2_mutation'
    AND NOT trigger_row.tgisinternal;

  IF trigger_count <> (SELECT count(*) FROM v3_legacy_physical_relations) THEN
    RAISE EXCEPTION 'expected one v2 mutation fence per physical relation, found %',
      trigger_count;
  END IF;

  SELECT count(*) INTO nonowner_relation_acl_count
  FROM pg_class relation_row
  CROSS JOIN LATERAL aclexplode(relation_row.relacl) acl_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND acl_row.grantee <> relation_row.relowner
    AND (
      EXISTS (
        SELECT 1
        FROM v3_legacy_physical_relations expected
        WHERE expected.relation_name = relation_row.relname
          AND relation_row.relkind IN ('r', 'p')
      )
      OR EXISTS (
        SELECT 1
        FROM v3_legacy_read_relations expected
        WHERE expected.relation_name = relation_row.relname
          AND expected.relation_kind = relation_row.relkind
      )
    );

  IF nonowner_relation_acl_count <> 0 THEN
    RAISE EXCEPTION 'v2 relations retain % non-owner ACL entries', nonowner_relation_acl_count;
  END IF;

  SELECT count(*) INTO nonowner_sequence_acl_count
  FROM pg_class relation_row
  JOIN v3_legacy_sequences expected ON expected.relation_name = relation_row.relname
  CROSS JOIN LATERAL aclexplode(relation_row.relacl) acl_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind = 'S'
    AND acl_row.grantee <> relation_row.relowner;

  IF nonowner_sequence_acl_count <> 0 THEN
    RAISE EXCEPTION 'v2 sequences retain % non-owner ACL entries', nonowner_sequence_acl_count;
  END IF;

  SELECT count(*) INTO unexpected_owner_count
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND (
      EXISTS (
        SELECT 1
        FROM v3_legacy_physical_relations expected
        WHERE expected.relation_name = relation_row.relname
          AND relation_row.relkind IN ('r', 'p')
      )
      OR EXISTS (
        SELECT 1
        FROM v3_legacy_read_relations expected
        WHERE expected.relation_name = relation_row.relname
          AND expected.relation_kind = relation_row.relkind
      )
      OR EXISTS (
        SELECT 1
        FROM v3_legacy_sequences expected
        WHERE expected.relation_name = relation_row.relname
          AND relation_row.relkind = 'S'
      )
    )
    AND relation_row.relowner <> 'letletme_v2_frozen_owner'::regrole;

  unexpected_owner_count := unexpected_owner_count
    + (SELECT count(*) FROM pg_proc function_row
       WHERE function_row.pronamespace = 'public'::regnamespace
         AND function_row.proowner <> 'letletme_v2_frozen_owner'::regrole)
    + (SELECT count(*) FROM pg_type type_row
       WHERE type_row.typnamespace = 'public'::regnamespace
         AND type_row.typtype = 'e'
         AND type_row.typowner <> 'letletme_v2_frozen_owner'::regrole);

  IF unexpected_owner_count <> 0 THEN
    RAISE EXCEPTION 'v2 frozen-owner handoff failed for % objects', unexpected_owner_count;
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_auth_members membership
       JOIN pg_roles member_role ON member_role.oid = membership.member
       JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
       WHERE member_role.rolname = session_user
         AND granted_role.rolname = 'letletme_v2_frozen_owner'
     )
     OR (
       NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)
       AND pg_has_role(session_user, 'letletme_v2_frozen_owner', 'MEMBER')
     )
     OR has_schema_privilege('letletme_v2_frozen_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'migration login still inherits the v2 frozen owner or owner can create in public';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles role_row
    WHERE role_row.rolname IN (
      'letletme_data_owner',
      'letletme_data_writer',
      'letletme_graphql_reader',
      'letletme_v2_frozen_owner'
    )
      AND (
        role_row.rolsuper
        OR role_row.rolcreatedb
        OR role_row.rolcreaterole
        OR role_row.rolcanlogin
        OR role_row.rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'v3 runtime/owner role privilege contract failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class relation_row
    WHERE relation_row.oid = 'public.sql_migrations'::regclass
      AND relation_row.relkind = 'v'
      AND 'security_invoker=true' = ANY (relation_row.reloptions)
  ) OR to_regclass('public.sql_migrations_v2') IS NULL THEN
    RAISE EXCEPTION 'migration ledger compatibility boundary is incomplete';
  END IF;

  IF (SELECT is_updatable FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = 'sql_migrations') <> 'YES' THEN
    RAISE EXCEPTION 'public.sql_migrations compatibility view is not updatable';
  END IF;

  SELECT count(*) INTO active_publication_count
  FROM ops.dataset_publications publication
  JOIN fpl.seasons season ON season.season_id = publication.season_id AND season.is_current
  WHERE publication.dataset = 'fpl:core'
    AND publication.event_id IS NULL
    AND publication.status = 'active'
    AND publication.manifest ->> 'schemaVersion' = 'v3'
    AND publication.manifest ->> 'state' = 'active';

  IF active_publication_count <> 1 THEN
    RAISE EXCEPTION 'expected one active current v3 core publication, found %',
      active_publication_count;
  END IF;

  IF (SELECT status FROM ops.migration_runs
      WHERE run_id = 'v3-20260808T160008Z-b9eddc0') <> 'activated' THEN
    RAISE EXCEPTION 'v3 migration run was not marked activated';
  END IF;
END
$activation_postconditions$;
