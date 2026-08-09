-- Approval-gated removal of the exact v2 reporting/RPC allowlist.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

SELECT pg_advisory_xact_lock(912883473);

DO $legacy_drop_approval$
DECLARE
  approval text := current_setting('letletme.v3_legacy_drop_approval', true);
  approved_run_count bigint;
BEGIN
  SELECT count(*) INTO approved_run_count
  FROM ops.migration_runs run
  WHERE run.status = 'activated'
    AND approval = 'APPROVE_V3_LEGACY_DROP ' || run.run_id
    AND run.metadata ->> 'v2FreezeState' = 'trigger_and_acl_fenced';

  IF approved_run_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = '0091 requires the exact legacy-drop approval for one activated cutover run';
  END IF;

  IF EXISTS (SELECT 1 FROM ops.migration_objects WHERE status = 'failed') THEN
    RAISE EXCEPTION 'legacy cleanup is blocked by failed migration evidence';
  END IF;
END
$legacy_drop_approval$;

DO $assume_v2_frozen_owner$
BEGIN
  EXECUTE format('GRANT letletme_v2_frozen_owner TO %I', session_user);
END
$assume_v2_frozen_owner$;

DO $legacy_reporting_scope$
DECLARE
  actual_functions text[];
  actual_materialized_views text[];
  actual_views text[];
  catalog_present boolean := to_regclass('public.public_league_trends_catalog') IS NOT NULL;
  expected_functions text[] := ARRAY[
    'get_captain_counts(integer,text,integer)',
    'get_pick_aggregation(integer,integer[])',
    'get_players_for_picker(integer,integer)',
    'get_transfer_aggregation(integer,integer[])',
    'reject_sealed_fpl_history_mutation()',
    'search_players_for_picker(text,integer,integer)'
  ]::text[];
  graphql_search_function_present boolean := to_regprocedure(
    'public.search_players_for_picker(text,integer,integer,integer,integer,integer,integer)'
  ) IS NOT NULL;
  touch_function_present boolean :=
    to_regprocedure('public.touch_public_league_trends_catalog_updated_at()') IS NOT NULL;
BEGIN
  SELECT array_agg(relation_row.relname::text ORDER BY relation_row.relname)
  INTO actual_materialized_views
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind = 'm';

  IF actual_materialized_views IS DISTINCT FROM ARRAY[
    'mv_tournament_event_snapshot',
    'mv_tournament_snapshot'
  ]::text[] THEN
    RAISE EXCEPTION '0091 materialized-view scope mismatch: %', actual_materialized_views;
  END IF;

  SELECT array_agg(relation_row.relname::text ORDER BY relation_row.relname)
  INTO actual_views
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'public'::regnamespace
    AND relation_row.relkind = 'v';

  IF actual_views IS DISTINCT FROM ARRAY[
    'sql_migrations',
    'v_tournament_event_result',
    'v_tournament_event_snapshot',
    'v_tournament_selection_stats',
    'v_tournament_snapshot'
  ]::text[] THEN
    RAISE EXCEPTION '0091 view scope mismatch: %', actual_views;
  END IF;

  SELECT array_agg(function_row.oid::regprocedure::text ORDER BY function_row.oid::regprocedure::text)
  INTO actual_functions
  FROM pg_proc function_row
  WHERE function_row.pronamespace = 'public'::regnamespace;

  IF catalog_present IS DISTINCT FROM touch_function_present
     OR catalog_present IS DISTINCT FROM graphql_search_function_present THEN
    RAISE EXCEPTION '0091 optional GraphQL mainline catalog/function pairing mismatch';
  END IF;

  IF catalog_present AND NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid = 'public.public_league_trends_catalog'::regclass
      AND trigger_row.tgname = 'public_league_trends_catalog_touch_updated_at'
      AND trigger_row.tgfoid =
        'public.touch_public_league_trends_catalog_updated_at()'::regprocedure
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION '0091 optional public-league catalog trigger is missing or invalid';
  END IF;

  IF touch_function_present THEN
    expected_functions := array_append(
      expected_functions,
      'search_players_for_picker(text,integer,integer,integer,integer,integer,integer)'
    );
    expected_functions := array_append(
      expected_functions,
      'touch_public_league_trends_catalog_updated_at()'
    );
  END IF;

  IF actual_functions IS DISTINCT FROM expected_functions THEN
    RAISE EXCEPTION '0091 public function scope mismatch: %', actual_functions;
  END IF;
END
$legacy_reporting_scope$;

DROP VIEW public.v_tournament_event_result;
DROP VIEW public.v_tournament_event_snapshot;
DROP VIEW public.v_tournament_selection_stats;
DROP VIEW public.v_tournament_snapshot;

DROP MATERIALIZED VIEW public.mv_tournament_snapshot;
DROP MATERIALIZED VIEW public.mv_tournament_event_snapshot;

DROP FUNCTION public.get_captain_counts(integer, text, integer);
DROP FUNCTION public.get_pick_aggregation(integer, integer[]);
DROP FUNCTION public.get_players_for_picker(integer, integer);
DROP FUNCTION public.get_transfer_aggregation(integer, integer[]);
DROP FUNCTION public.search_players_for_picker(text, integer, integer);

DO $drop_optional_catalog_touch_function$
BEGIN
  IF to_regclass('public.public_league_trends_catalog') IS NOT NULL THEN
    EXECUTE
      'DROP TRIGGER public_league_trends_catalog_touch_updated_at '
      'ON public.public_league_trends_catalog';
  END IF;

  IF to_regprocedure('public.touch_public_league_trends_catalog_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP FUNCTION public.touch_public_league_trends_catalog_updated_at()';
  END IF;

  IF to_regprocedure(
    'public.search_players_for_picker(text,integer,integer,integer,integer,integer,integer)'
  ) IS NOT NULL THEN
    EXECUTE
      'DROP FUNCTION public.search_players_for_picker('
      'text, integer, integer, integer, integer, integer, integer)';
  END IF;
END
$drop_optional_catalog_touch_function$;

DO $legacy_reporting_postcondition$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'public'::regnamespace
      AND relation_row.relkind = 'm'
  ) THEN
    RAISE EXCEPTION '0091 left a public materialized view';
  END IF;

  IF (SELECT count(*) FROM pg_class relation_row
      WHERE relation_row.relnamespace = 'public'::regnamespace
        AND relation_row.relkind = 'v') <> 1
     OR to_regclass('public.sql_migrations') IS NULL THEN
    RAISE EXCEPTION '0091 changed the migration-ledger compatibility view unexpectedly';
  END IF;

  IF (SELECT count(*) FROM pg_proc function_row
      WHERE function_row.pronamespace = 'public'::regnamespace) <> 1
     OR to_regprocedure('public.reject_sealed_fpl_history_mutation()') IS NULL THEN
    RAISE EXCEPTION '0091 left an unexpected public function';
  END IF;
END
$legacy_reporting_postcondition$;

DO $release_v2_frozen_owner$
BEGIN
  EXECUTE format('REVOKE letletme_v2_frozen_owner FROM %I', session_user);
END
$release_v2_frozen_owner$;

SET LOCAL ROLE letletme_data_owner;

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
  '0091_drop_v2_reporting_and_rpcs',
  'public legacy views, materialized views, and read RPCs',
  'approved drop manifest',
  encode(sha256(convert_to('0091_drop_v2_reporting_and_rpcs_v2', 'UTF8')), 'hex'),
  11 + CASE
    WHEN to_regclass('public.public_league_trends_catalog') IS NULL THEN 0
    ELSE 2
  END,
  0,
  NULL,
  NULL,
  0,
  '[]'::jsonb,
  'passed'
FROM ops.migration_runs run
WHERE current_setting('letletme.v3_legacy_drop_approval', true)
  = 'APPROVE_V3_LEGACY_DROP ' || run.run_id
ON CONFLICT (run_id, check_name, source_object, target_object) DO UPDATE SET
  target_row_count = EXCLUDED.target_row_count,
  failed_count = EXCLUDED.failed_count,
  status = EXCLUDED.status,
  executed_at = now();

UPDATE ops.migration_runs run
SET
  metadata = run.metadata || jsonb_build_object(
    'legacyDropApproval', current_setting('letletme.v3_legacy_drop_approval', true),
    'legacyDropStartedAt', now(),
    'legacyDropPhase', 'reporting_and_rpcs_removed'
  ),
  updated_at = now()
WHERE current_setting('letletme.v3_legacy_drop_approval', true)
  = 'APPROVE_V3_LEGACY_DROP ' || run.run_id;

RESET ROLE;
