\set ON_ERROR_STOP on

SET statement_timeout = '5min';
SET lock_timeout = '5s';

DO $catalog_contract$
DECLARE
  active_publication_count bigint;
  legacy_physical_count bigint;
  legacy_trigger_count bigint;
  migration_login_inherits_frozen_owner boolean;
  nonowner_column_acl_count bigint;
  nonowner_relation_acl_count bigint;
  nonowner_sequence_acl_count bigint;
  unexpected_frozen_owner_count bigint;
BEGIN
  SELECT count(*) INTO legacy_physical_count
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p');

  SELECT count(*) INTO legacy_trigger_count
  FROM pg_class relation_row
  JOIN pg_trigger trigger_row ON trigger_row.tgrelid = relation_row.oid
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p')
    AND trigger_row.tgname = 'v3_reject_v2_mutation'
    AND trigger_row.tgfoid = 'ops.reject_v2_mutation()'::regprocedure
    AND NOT trigger_row.tgisinternal;

  IF legacy_physical_count <> 192 + CASE
       WHEN to_regclass('public.public_league_trends_catalog') IS NULL THEN 0
       ELSE 1
     END
     OR legacy_trigger_count <> legacy_physical_count THEN
    RAISE EXCEPTION 'v2 physical/fence count mismatch: physical=%, fences=%',
      legacy_physical_count,
      legacy_trigger_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind IN ('r', 'p')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = relation_row.oid
          AND trigger_row.tgname = 'v3_reject_v2_mutation'
          AND trigger_row.tgfoid = 'ops.reject_v2_mutation()'::regprocedure
          AND NOT trigger_row.tgisinternal
      )
  ) THEN
    RAISE EXCEPTION 'at least one public v2 physical relation lacks its mutation fence';
  END IF;

  SELECT count(*) INTO nonowner_relation_acl_count
  FROM pg_class relation_row
  CROSS JOIN LATERAL aclexplode(relation_row.relacl) acl_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p', 'm', 'v')
    AND NOT (relation_row.relkind = 'v' AND relation_row.relname = 'sql_migrations')
    AND acl_row.grantee <> relation_row.relowner;

  SELECT count(*) INTO nonowner_column_acl_count
  FROM pg_attribute attribute_row
  JOIN pg_class relation_row ON relation_row.oid = attribute_row.attrelid
  CROSS JOIN LATERAL aclexplode(attribute_row.attacl) acl_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p', 'm', 'v')
    AND NOT (relation_row.relkind = 'v' AND relation_row.relname = 'sql_migrations')
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped
    AND acl_row.grantee <> relation_row.relowner;

  SELECT count(*) INTO nonowner_sequence_acl_count
  FROM pg_class relation_row
  CROSS JOIN LATERAL aclexplode(relation_row.relacl) acl_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind = 'S'
    AND acl_row.grantee <> relation_row.relowner;

  IF nonowner_relation_acl_count <> 0
     OR nonowner_column_acl_count <> 0
     OR nonowner_sequence_acl_count <> 0 THEN
    RAISE EXCEPTION 'v2 ACL freeze failed: relation=%, column=%, sequence=%',
      nonowner_relation_acl_count,
      nonowner_column_acl_count,
      nonowner_sequence_acl_count;
  END IF;

  SELECT count(*) INTO unexpected_frozen_owner_count
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
    AND NOT (relation_row.relkind = 'v' AND relation_row.relname = 'sql_migrations')
    AND relation_row.relowner <> 'letletme_v2_frozen_owner'::regrole;

  unexpected_frozen_owner_count := unexpected_frozen_owner_count
    + (SELECT count(*) FROM pg_proc function_row
       WHERE function_row.pronamespace = 'public'::regnamespace
         AND function_row.proowner <> 'letletme_v2_frozen_owner'::regrole)
    + (SELECT count(*) FROM pg_type type_row
       WHERE type_row.typnamespace = 'public'::regnamespace
         AND type_row.typtype = 'e'
         AND type_row.typowner <> 'letletme_v2_frozen_owner'::regrole);

  -- pg_has_role() reports every superuser as a member of every role even when
  -- pg_auth_members has no grant edge. The cutover login is privileged, while
  -- runtime logins are tested separately. Match 0090's postcondition: reject a
  -- real grant for any login and inherited membership for non-superusers.
  SELECT
    EXISTS (
      SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles member_role ON member_role.oid = membership.member
      JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname = session_user
        AND granted_role.rolname = 'letletme_v2_frozen_owner'
    ) OR (
      NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)
      AND pg_has_role(session_user, 'letletme_v2_frozen_owner', 'MEMBER')
    )
  INTO migration_login_inherits_frozen_owner;

  IF unexpected_frozen_owner_count <> 0
     OR migration_login_inherits_frozen_owner
     OR has_schema_privilege('letletme_v2_frozen_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION
      'v2 frozen-owner boundary failed: wrong owners=%, login member=%, create=%',
      unexpected_frozen_owner_count,
      migration_login_inherits_frozen_owner,
      has_schema_privilege('letletme_v2_frozen_owner', 'public', 'CREATE');
  END IF;

  IF to_regclass('public.sql_migrations_v2') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_class relation_row
       WHERE relation_row.oid = 'public.sql_migrations'::regclass
         AND relation_row.relkind = 'v'
         AND 'security_invoker=true' = ANY (relation_row.reloptions)
     ) THEN
    RAISE EXCEPTION 'v3 migration ledger compatibility objects are invalid';
  END IF;

  IF (SELECT is_updatable FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = 'sql_migrations') <> 'YES'
     OR (SELECT is_insertable_into FROM information_schema.views
         WHERE table_schema = 'public' AND table_name = 'sql_migrations') <> 'YES' THEN
    RAISE EXCEPTION 'public.sql_migrations compatibility view is not writable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sql_migrations_v2 legacy
    LEFT JOIN ops.schema_migrations target USING (filename)
    WHERE target.filename IS NULL
       OR legacy.checksum IS DISTINCT FROM target.checksum
       OR legacy.applied_at IS DISTINCT FROM target.applied_at
  ) THEN
    RAISE EXCEPTION 'authoritative v3 ledger does not preserve every frozen v2 ledger row';
  END IF;

  IF EXISTS (
    (SELECT filename, checksum, applied_at FROM public.sql_migrations
     EXCEPT
     SELECT filename, checksum, applied_at FROM ops.schema_migrations)
    UNION ALL
    (SELECT filename, checksum, applied_at FROM ops.schema_migrations
     EXCEPT
     SELECT filename, checksum, applied_at FROM public.sql_migrations)
  ) THEN
    RAISE EXCEPTION 'public compatibility ledger differs from ops.schema_migrations';
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
    RAISE EXCEPTION 'v3 role privilege contract failed';
  END IF;

  IF has_table_privilege('letletme_data_writer', 'public.events', 'SELECT')
     OR has_table_privilege('letletme_data_writer', 'public.events', 'INSERT')
     OR has_table_privilege('letletme_graphql_reader', 'public.events', 'SELECT')
     OR has_table_privilege('service_role', 'public.events', 'SELECT')
     OR has_table_privilege('service_role', 'public.events', 'INSERT')
     OR (
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres')
       AND has_table_privilege('postgres', 'public.events', 'INSERT')
     ) THEN
    RAISE EXCEPTION 'a runtime role retains direct v2 events access';
  END IF;

  IF NOT has_table_privilege('letletme_data_writer', 'fpl.events', 'SELECT')
     OR NOT has_table_privilege('letletme_data_writer', 'fpl.events', 'INSERT')
     OR NOT has_table_privilege('letletme_graphql_reader', 'fpl.events', 'SELECT')
     OR has_table_privilege('letletme_graphql_reader', 'fpl.events', 'INSERT') THEN
    RAISE EXCEPTION 'v3 runtime role grants are invalid';
  END IF;

  IF has_table_privilege('letletme_data_writer', 'ops.migration_runs', 'SELECT')
     OR NOT has_column_privilege(
       'letletme_data_writer', 'ops.migration_runs', 'run_id', 'SELECT'
     )
     OR NOT has_column_privilege(
       'letletme_data_writer', 'ops.migration_runs', 'status', 'SELECT'
     )
     OR NOT has_column_privilege(
       'letletme_data_writer', 'ops.migration_runs', 'metadata', 'SELECT'
     )
     OR has_table_privilege('letletme_data_writer', 'ops.migration_runs', 'INSERT')
     OR has_table_privilege('letletme_data_writer', 'ops.migration_runs', 'UPDATE')
     OR has_table_privilege('letletme_data_writer', 'ops.migration_runs', 'DELETE')
     OR has_table_privilege('letletme_data_writer', 'ops.migration_runs', 'TRUNCATE')
     OR has_table_privilege('letletme_data_writer', 'ops.migration_runs', 'REFERENCES')
     OR has_table_privilege('letletme_data_writer', 'ops.migration_runs', 'TRIGGER')
     OR EXISTS (
       SELECT 1
       FROM pg_attribute attribute_row
       WHERE attribute_row.attrelid = 'ops.migration_runs'::regclass
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
         AND (
           (
             attribute_row.attname <> ALL (ARRAY['run_id', 'status', 'metadata'])
             AND has_column_privilege(
               'letletme_data_writer',
               attribute_row.attrelid,
               attribute_row.attnum,
               'SELECT'
             )
           )
           OR has_column_privilege(
             'letletme_data_writer',
             attribute_row.attrelid,
             attribute_row.attnum,
             'INSERT'
           )
           OR has_column_privilege(
             'letletme_data_writer',
             attribute_row.attrelid,
             attribute_row.attnum,
             'UPDATE'
           )
           OR has_column_privilege(
             'letletme_data_writer',
             attribute_row.attrelid,
             attribute_row.attnum,
             'REFERENCES'
           )
         )
     ) THEN
    RAISE EXCEPTION 'Data writer migration-run preflight privilege boundary failed';
  END IF;

  IF NOT has_schema_privilege('letletme_data_writer', 'reporting', 'USAGE')
     OR has_schema_privilege('letletme_data_writer', 'reporting', 'CREATE')
     OR NOT has_table_privilege(
       'letletme_data_writer',
       'reporting.tournament_selection_stats',
       'SELECT'
     )
     OR NOT has_table_privilege(
       'letletme_data_writer',
       'reporting.tournament_entry_event_summaries',
       'SELECT'
     )
     OR NOT has_function_privilege(
       'letletme_data_writer',
       'reporting.refresh_tournament_selection_stats()',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'letletme_data_writer',
       'reporting.refresh_tournament_entry_event_summaries()',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_class relation_row
       WHERE relation_row.relnamespace = 'reporting'::regnamespace
         AND relation_row.relkind IN ('v', 'm')
         AND (
           (
             relation_row.relname NOT IN (
               'tournament_selection_stats',
               'tournament_entry_event_summaries'
             )
             AND has_table_privilege(
               'letletme_data_writer', relation_row.oid, 'SELECT'
             )
           )
           OR has_table_privilege(
             'letletme_data_writer',
             relation_row.oid,
             'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           )
         )
     ) THEN
    RAISE EXCEPTION 'Data writer reporting refresh/read-model privilege boundary failed';
  END IF;
END
$catalog_contract$;

BEGIN;

DO $assume_v2_frozen_owner_for_validation$
BEGIN
  EXECUTE format('GRANT letletme_v2_frozen_owner TO %I', session_user);
END
$assume_v2_frozen_owner_for_validation$;

SET LOCAL ROLE letletme_v2_frozen_owner;

DO $mutation_fence_contract$
DECLARE
  rejected_attempts integer := 0;
BEGIN
  BEGIN
    INSERT INTO public.events DEFAULT VALUES;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    rejected_attempts := rejected_attempts + 1;
  END;

  BEGIN
    UPDATE public.events SET name = name WHERE false;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    rejected_attempts := rejected_attempts + 1;
  END;

  BEGIN
    DELETE FROM public.events WHERE false;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    rejected_attempts := rejected_attempts + 1;
  END;

  BEGIN
    TRUNCATE TABLE public.graphql_schema_migrations;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    rejected_attempts := rejected_attempts + 1;
  END;

  BEGIN
    INSERT INTO public.events_2627 DEFAULT VALUES;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    rejected_attempts := rejected_attempts + 1;
  END;

  IF rejected_attempts <> 5 THEN
    RAISE EXCEPTION 'expected five rejected owner-level v2 mutations, observed %',
      rejected_attempts;
  END IF;
END
$mutation_fence_contract$;

RESET ROLE;
ROLLBACK;

BEGIN;
SET LOCAL ROLE letletme_data_owner;

INSERT INTO public.sql_migrations (filename, checksum)
VALUES ('v3_compatibility_probe.sql', repeat('0', 64));

DO $compatibility_write_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ops.schema_migrations
    WHERE filename = 'v3_compatibility_probe.sql'
      AND checksum = repeat('0', 64)
  ) THEN
    RAISE EXCEPTION 'compatibility view did not write through to the authoritative ledger';
  END IF;
END
$compatibility_write_contract$;

RESET ROLE;
ROLLBACK;

SELECT
  '0090_activation_validation_passed' AS status,
  (SELECT count(*) FROM pg_class
   WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')) AS frozen_relations,
  (SELECT count(*) FROM pg_trigger
   WHERE tgname = 'v3_reject_v2_mutation' AND NOT tgisinternal) AS mutation_fences,
  (SELECT count(*) FROM ops.dataset_publications WHERE status = 'active') AS active_publications;
