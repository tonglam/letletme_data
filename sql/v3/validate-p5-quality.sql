\set ON_ERROR_STOP on

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10min';
SET LOCAL lock_timeout = '10s';

DO $migration_contract$
DECLARE
  completed_seasons text[];
BEGIN
  IF (SELECT status FROM ops.migration_runs
      WHERE run_id = 'v3-20260808T160008Z-b9eddc0') <> 'activated' THEN
    RAISE EXCEPTION 'P5 quality validation requires the activated v3 migration run';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.migration_objects
    WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
      AND (status <> 'passed' OR failed_count <> 0)
  ) THEN
    RAISE EXCEPTION 'P5 found a failed migration reconciliation item';
  END IF;

  SELECT array_agg(season_code ORDER BY season_code)
  INTO completed_seasons
  FROM fpl.seasons
  WHERE lifecycle_state = 'completed';

  IF completed_seasons IS DISTINCT FROM ARRAY[
    '1617', '1718', '1819', '1920', '2021',
    '2122', '2223', '2324', '2425', '2526'
  ]::text[] THEN
    RAISE EXCEPTION 'P5 completed-season authority differs from 1617..2526: %', completed_seasons;
  END IF;

  IF (SELECT count(*) FROM fpl.seasons WHERE is_current) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM fpl.seasons
       WHERE is_current AND season_code = '2627' AND lifecycle_state = 'preseason'
     ) THEN
    RAISE EXCEPTION 'P5 current-season authority is not the single 2627 preseason row';
  END IF;
END
$migration_contract$;

DO $fpl_shape_contract$
DECLARE
  failure_count bigint;
BEGIN
  WITH completed_counts AS (
    SELECT
      season.season_id,
      (SELECT count(*) FROM fpl.teams team WHERE team.season_id = season.season_id) AS teams,
      (SELECT count(*) FROM fpl.events event WHERE event.season_id = season.season_id) AS events,
      (SELECT count(*) FROM fpl.fixtures fixture WHERE fixture.season_id = season.season_id) AS fixtures
    FROM fpl.seasons season
    WHERE season.lifecycle_state = 'completed'
  )
  SELECT count(*) INTO failure_count
  FROM completed_counts
  WHERE teams <> 20 OR events <> 38 OR fixtures <> 380;

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 completed-season 20/38/380 failures: %', failure_count;
  END IF;

  WITH team_appearances AS (
    SELECT
      team.season_id,
      team.team_id,
      count(fixture.fixture_id) AS fixture_count
    FROM fpl.teams team
    JOIN fpl.seasons season
      ON season.season_id = team.season_id
     AND season.lifecycle_state = 'completed'
    LEFT JOIN fpl.fixtures fixture
      ON fixture.season_id = team.season_id
     AND (fixture.team_h_id = team.team_id OR fixture.team_a_id = team.team_id)
    GROUP BY team.season_id, team.team_id
  )
  SELECT count(*) INTO failure_count
  FROM team_appearances
  WHERE fixture_count <> 38;

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 completed-team 38-fixture failures: %', failure_count;
  END IF;

  SELECT count(*) INTO failure_count
  FROM fpl.fixtures fixture
  WHERE fixture.team_h_id = fixture.team_a_id
     OR (fixture.finished AND (fixture.team_h_score IS NULL OR fixture.team_a_score IS NULL));

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 invalid fixture team/score rows: %', failure_count;
  END IF;
END
$fpl_shape_contract$;

DO $player_summary_contract$
DECLARE
  failure_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'reporting'
      AND table_name = 'player_season_summaries'
      AND column_name IN ('event_id', 'team_id')
  ) THEN
    RAISE EXCEPTION 'P5 player summary unexpectedly exposes event_id/team_id';
  END IF;

  IF (SELECT count(*) FROM reporting.player_season_summaries)
     <> (SELECT count(*) FROM fpl.players) THEN
    RAISE EXCEPTION 'P5 player summary/player cardinality mismatch';
  END IF;

  IF (
    SELECT count(*)
    FROM reporting.player_season_summaries summary
    JOIN fpl.seasons season ON season.season_id = summary.season_id
    WHERE season.season_code = '2526'
  ) <> 841 THEN
    RAISE EXCEPTION 'P5 2526 player summary count is not 841';
  END IF;

  WITH expected AS (
    SELECT
      player.season_id,
      player.element_id,
      player.element_type,
      count(stats.event_id)::integer AS gameweeks_available,
      count(*) FILTER (WHERE stats.starts IS TRUE)::integer AS gameweeks_started,
      coalesce(sum(stats.minutes), 0)::integer AS minutes,
      coalesce(sum(stats.goals_scored), 0)::integer AS goals_scored,
      coalesce(sum(stats.assists), 0)::integer AS assists,
      coalesce(sum(stats.clean_sheets), 0)::integer AS clean_sheets,
      coalesce(sum(stats.goals_conceded), 0)::integer AS goals_conceded,
      coalesce(sum(stats.own_goals), 0)::integer AS own_goals,
      coalesce(sum(stats.penalties_saved), 0)::integer AS penalties_saved,
      coalesce(sum(stats.penalties_missed), 0)::integer AS penalties_missed,
      coalesce(sum(stats.yellow_cards), 0)::integer AS yellow_cards,
      coalesce(sum(stats.red_cards), 0)::integer AS red_cards,
      coalesce(sum(stats.saves), 0)::integer AS saves,
      coalesce(sum(stats.bonus), 0)::integer AS bonus,
      coalesce(sum(stats.bps), 0)::integer AS bps,
      coalesce(sum(stats.total_points), 0)::integer AS total_points,
      coalesce(sum(stats.defensive_contribution), 0)::integer AS defensive_contribution,
      coalesce(sum(stats.expected_goals), 0::numeric) AS expected_goals,
      coalesce(sum(stats.expected_assists), 0::numeric) AS expected_assists,
      coalesce(sum(stats.expected_goal_involvements), 0::numeric) AS expected_goal_involvements,
      coalesce(sum(stats.expected_goals_conceded), 0::numeric) AS expected_goals_conceded,
      count(*) FILTER (WHERE stats.in_dream_team IS TRUE)::integer AS dream_team_appearances
    FROM fpl.players player
    LEFT JOIN fpl.player_gameweek_stats stats
      ON stats.season_id = player.season_id
     AND stats.element_id = player.element_id
    GROUP BY player.season_id, player.element_id, player.element_type
  )
  SELECT count(*) INTO failure_count
  FROM expected
  FULL JOIN reporting.player_season_summaries summary
    USING (season_id, element_id, element_type)
  WHERE expected.season_id IS NULL
     OR summary.season_id IS NULL
     OR summary.gameweeks_available IS DISTINCT FROM expected.gameweeks_available
     OR summary.gameweeks_started IS DISTINCT FROM expected.gameweeks_started
     OR summary.minutes IS DISTINCT FROM expected.minutes
     OR summary.goals_scored IS DISTINCT FROM expected.goals_scored
     OR summary.assists IS DISTINCT FROM expected.assists
     OR summary.clean_sheets IS DISTINCT FROM expected.clean_sheets
     OR summary.goals_conceded IS DISTINCT FROM expected.goals_conceded
     OR summary.own_goals IS DISTINCT FROM expected.own_goals
     OR summary.penalties_saved IS DISTINCT FROM expected.penalties_saved
     OR summary.penalties_missed IS DISTINCT FROM expected.penalties_missed
     OR summary.yellow_cards IS DISTINCT FROM expected.yellow_cards
     OR summary.red_cards IS DISTINCT FROM expected.red_cards
     OR summary.saves IS DISTINCT FROM expected.saves
     OR summary.bonus IS DISTINCT FROM expected.bonus
     OR summary.bps IS DISTINCT FROM expected.bps
     OR summary.total_points IS DISTINCT FROM expected.total_points
     OR summary.defensive_contribution IS DISTINCT FROM expected.defensive_contribution
     OR summary.expected_goals IS DISTINCT FROM expected.expected_goals
     OR summary.expected_assists IS DISTINCT FROM expected.expected_assists
     OR summary.expected_goal_involvements IS DISTINCT FROM expected.expected_goal_involvements
     OR summary.expected_goals_conceded IS DISTINCT FROM expected.expected_goals_conceded
     OR summary.dream_team_appearances IS DISTINCT FROM expected.dream_team_appearances;

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 player summary rollup mismatches: %', failure_count;
  END IF;
END
$player_summary_contract$;

DO $market_reconstruction_contract$
DECLARE
  evidence_hash text;
  evidence_row_count bigint;
  legacy_drop_phase text;
  mismatch_count bigint;
  target_hash text;
  target_row_count bigint;
BEGIN
  SELECT metadata ->> 'legacyDropPhase'
  INTO legacy_drop_phase
  FROM ops.migration_runs
  WHERE run_id = 'v3-20260808T160008Z-b9eddc0';

  IF to_regclass('public.player_values_history') IS NOT NULL
     AND to_regclass('public.player_values') IS NOT NULL THEN
    WITH source_values AS (
      SELECT
        history.season AS season_code,
        history.element_id,
        history.element_type,
        history.event_id,
        history.value,
        btrim(history.change_date) AS change_date,
        history.last_value,
        history.change_type::text AS change_type
      FROM public.player_values_history history
      WHERE history.season <> '2627'

      UNION ALL

      SELECT
        '2627',
        current.element_id,
        current.element_type,
        current.event_id,
        current.value,
        btrim(current.change_date),
        current.last_value,
        current.change_type::text
      FROM public.player_values current
    ), target_values AS (
      SELECT
        target.season_code,
        target.element_id,
        target.element_type,
        target.event_id,
        target.value,
        to_char(target.snapshot_date, 'YYYYMMDD') AS change_date,
        target.last_value,
        target.change_type::text AS change_type
      FROM reporting.player_value_changes target
    ), differences AS (
      (SELECT * FROM source_values EXCEPT SELECT * FROM target_values)
      UNION ALL
      (SELECT * FROM target_values EXCEPT SELECT * FROM source_values)
    )
    SELECT count(*) INTO mismatch_count FROM differences;

    IF mismatch_count <> 0 THEN
      RAISE EXCEPTION 'P5 player value reconstruction mismatches: %', mismatch_count;
    END IF;
  ELSIF to_regclass('public.player_values_history') IS NULL
        AND to_regclass('public.player_values') IS NULL
        AND legacy_drop_phase IN ('physical_objects_removed', 'complete') THEN
    SELECT evidence.target_row_count, evidence.target_hash
    INTO evidence_row_count, evidence_hash
    FROM ops.migration_objects evidence
    WHERE evidence.run_id = 'v3-20260808T160008Z-b9eddc0'
      AND evidence.check_name = '0085_reporting_player_value_changes_rows'
      AND evidence.source_object = 'public.player_values_history + public.player_values'
      AND evidence.target_object = 'reporting.player_value_changes'
      AND evidence.source_row_count = evidence.target_row_count
      AND evidence.source_hash = evidence.target_hash
      AND evidence.failed_count = 0
      AND evidence.status = 'passed';

    SELECT
      count(*)::bigint,
      encode(
        sha256(convert_to(
          coalesce(string_agg(canonical_row, E'\n' ORDER BY canonical_row), ''),
          'UTF8'
        )),
        'hex'
      )
    INTO target_row_count, target_hash
    FROM (
      SELECT jsonb_build_array(
        target.season_code,
        target.element_id,
        target.element_type,
        target.event_id,
        target.value,
        to_char(target.snapshot_date, 'YYYYMMDD'),
        target.last_value,
        target.change_type::text
      )::text AS canonical_row
      FROM reporting.player_value_changes target
    ) target_rows;

    IF evidence_row_count IS NULL
       OR target_row_count <> evidence_row_count
       OR target_hash IS DISTINCT FROM evidence_hash THEN
      RAISE EXCEPTION
        'P5 post-cleanup player value evidence/current target mismatch: evidence %/%, target %/%',
        evidence_row_count,
        evidence_hash,
        target_row_count,
        target_hash;
    END IF;
  ELSE
    RAISE EXCEPTION 'P5 player value source/cleanup boundary is incomplete or ambiguous';
  END IF;

  IF (SELECT count(*) FROM fpl.player_market_snapshots
      WHERE snapshot_source = 'legacy_value_seed') <> 564 THEN
    RAISE EXCEPTION 'P5 legacy value seed count is not 564';
  END IF;
END
$market_reconstruction_contract$;

DO $provider_contract$
BEGIN
  IF (SELECT count(*) FROM understat.matches) <> 4560
     OR (SELECT count(*) FROM understat.player_match_stats) <> 129576
     OR (SELECT count(*) FROM bridge.entity_links) <> 1909 THEN
    RAISE EXCEPTION 'P5 Understat/bridge B0 count contract failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM bridge.entity_links link
    WHERE link.status IN ('auto_verified', 'manual_verified')
      AND (link.left_entity_id IS NULL OR btrim(link.left_entity_id) = '')
  ) THEN
    RAISE EXCEPTION 'P5 verified entity link is incomplete';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_index index_row
    WHERE index_row.indexrelid IN (
      'bridge.bridge_entity_links_verified_left_idx'::regclass,
      'bridge.bridge_entity_links_verified_right_idx'::regclass,
      'bridge.bridge_match_links_verified_left_idx'::regclass,
      'bridge.bridge_match_links_verified_right_idx'::regclass
    )
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NOT NULL
  ) <> 4 THEN
    RAISE EXCEPTION 'P5 verified-link uniqueness indexes are incomplete';
  END IF;
END
$provider_contract$;

DO $reporting_contract$
DECLARE
  failure_count bigint;
BEGIN
  SELECT count(*) INTO failure_count
  FROM reporting.tournament_selection_stats stats
  WHERE stats.total_entries <= 0
     OR stats.selected_count < 0
     OR stats.selected_count > stats.total_entries
     OR stats.captain_count < 0
     OR stats.captain_count > stats.total_entries
     OR stats.vice_captain_count < 0
     OR stats.vice_captain_count > stats.total_entries
     OR stats.selection_percentage IS DISTINCT FROM
        round(stats.selected_count::numeric * 100 / stats.total_entries, 4)
     OR stats.captain_percentage IS DISTINCT FROM
        round(stats.captain_count::numeric * 100 / stats.total_entries, 4)
     OR stats.vice_captain_percentage IS DISTINCT FROM
        round(stats.vice_captain_count::numeric * 100 / stats.total_entries, 4)
     OR stats.effective_ownership_percentage IS DISTINCT FROM
        round(stats.effective_selection_count::numeric * 100 / stats.total_entries, 4);

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 tournament selection row failures: %', failure_count;
  END IF;

  WITH scope_totals AS (
    SELECT
      tournament_id,
      event_id,
      min(total_entries) AS min_entries,
      max(total_entries) AS max_entries,
      sum(selected_count) AS selections,
      sum(captain_count) AS captains,
      sum(vice_captain_count) AS vice_captains
    FROM reporting.tournament_selection_stats
    GROUP BY tournament_id, event_id
  )
  SELECT count(*) INTO failure_count
  FROM scope_totals
  WHERE min_entries <> max_entries
     OR selections <> min_entries * 15
     OR captains <> min_entries
     OR vice_captains <> min_entries;

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 tournament selection scope failures: %', failure_count;
  END IF;

  IF (
    SELECT count(*)
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'reporting'::regnamespace
      AND relation_row.relkind = 'm'
      AND relation_row.relispopulated
  ) <> 2 THEN
    RAISE EXCEPTION 'P5 reporting materialized views are not both populated';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_class relation_row
    WHERE relation_row.relnamespace = 'reporting'::regnamespace
      AND relation_row.relkind = 'm'
      AND EXISTS (
        SELECT 1
        FROM pg_index index_row
        WHERE index_row.indrelid = relation_row.oid
          AND index_row.indisunique
          AND index_row.indisvalid
          AND index_row.indisready
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'P5 reporting materialized-view unique indexes are incomplete';
  END IF;
END
$reporting_contract$;

DO $catalog_integrity_contract$
DECLARE
  failure_count bigint;
BEGIN
  SELECT count(*) INTO failure_count
  FROM pg_constraint constraint_row
  JOIN pg_class relation_row ON relation_row.oid = constraint_row.conrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops')
    AND NOT constraint_row.convalidated;

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 unvalidated constraints: %', failure_count;
  END IF;

  SELECT count(*) INTO failure_count
  FROM pg_index index_row
  JOIN pg_class relation_row ON relation_row.oid = index_row.indrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops')
    AND (NOT index_row.indisvalid OR NOT index_row.indisready);

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 invalid or unready indexes: %', failure_count;
  END IF;

  SELECT count(*) INTO failure_count
  FROM pg_constraint constraint_row
  JOIN pg_class relation_row ON relation_row.oid = constraint_row.conrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE constraint_row.contype = 'f'
    AND namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'ops')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index index_row
      WHERE index_row.indrelid = constraint_row.conrelid
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND (
          SELECT array_agg(key_column.attnum ORDER BY key_column.ordinality)
          FROM unnest(index_row.indkey::smallint[]) WITH ORDINALITY
            AS key_column(attnum, ordinality)
          WHERE key_column.ordinality <= cardinality(constraint_row.conkey)
        ) = constraint_row.conkey
    );

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 foreign keys without a supporting index: %', failure_count;
  END IF;

  WITH index_contracts AS (
    SELECT
      index_row.indrelid,
      index_row.indisunique,
      index_row.indisprimary,
      index_row.indisexclusion,
      index_row.indkey::text AS key_columns,
      index_row.indclass::text AS operator_classes,
      index_row.indcollation::text AS collations,
      index_row.indoption::text AS options,
      coalesce(pg_get_expr(index_row.indexprs, index_row.indrelid), '') AS expressions,
      coalesce(pg_get_expr(index_row.indpred, index_row.indrelid), '') AS predicate,
      count(*) AS copies
    FROM pg_index index_row
    JOIN pg_class relation_row ON relation_row.oid = index_row.indrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops')
    GROUP BY
      index_row.indrelid,
      index_row.indisunique,
      index_row.indisprimary,
      index_row.indisexclusion,
      index_row.indkey::text,
      index_row.indclass::text,
      index_row.indcollation::text,
      index_row.indoption::text,
      coalesce(pg_get_expr(index_row.indexprs, index_row.indrelid), ''),
      coalesce(pg_get_expr(index_row.indpred, index_row.indrelid), '')
  )
  SELECT count(*) INTO failure_count
  FROM index_contracts
  WHERE copies > 1;

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 exact duplicate index contracts: %', failure_count;
  END IF;
END
$catalog_integrity_contract$;

DO $security_contract$
DECLARE
  failure_count bigint;
  role_name text;
  schema_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'letletme_web_auth') THEN
    RAISE EXCEPTION 'P5 dedicated Web auth capability role is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles role_row
    WHERE role_row.rolname = 'letletme_web_auth'
      AND (
        role_row.rolcanlogin
        OR role_row.rolsuper
        OR role_row.rolcreatedb
        OR role_row.rolcreaterole
        OR role_row.rolinherit
        OR role_row.rolreplication
        OR role_row.rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'P5 letletme_web_auth capability role attributes are unsafe';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles capability_role ON capability_role.oid = membership.roleid
    JOIN pg_roles login_role ON login_role.oid = membership.member
    WHERE capability_role.rolname = 'letletme_web_auth'
      AND login_role.rolcanlogin
      AND login_role.rolinherit
      AND NOT login_role.rolsuper
      AND NOT login_role.rolcreatedb
      AND NOT login_role.rolcreaterole
      AND NOT login_role.rolreplication
      AND NOT login_role.rolbypassrls
  ) THEN
    RAISE EXCEPTION 'P5 dedicated Web auth runtime LOGIN is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles capability_role ON capability_role.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE capability_role.rolname = 'letletme_web_auth'
      AND (
        NOT member_role.rolcanlogin
        OR NOT member_role.rolinherit
        OR member_role.rolsuper
        OR member_role.rolcreatedb
        OR member_role.rolcreaterole
        OR member_role.rolreplication
        OR member_role.rolbypassrls
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_auth_members web_membership
    JOIN pg_roles web_capability ON web_capability.oid = web_membership.roleid
    JOIN pg_auth_members extra_membership ON extra_membership.member = web_membership.member
    WHERE web_capability.rolname = 'letletme_web_auth'
      AND extra_membership.roleid <> web_membership.roleid
  ) THEN
    RAISE EXCEPTION 'P5 Web auth runtime LOGIN membership/attribute boundary failed';
  END IF;

  FOREACH schema_name IN ARRAY ARRAY['fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops']
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_namespace namespace_row
      CROSS JOIN LATERAL aclexplode(coalesce(
        namespace_row.nspacl,
        acldefault('n', namespace_row.nspowner)
      )) acl_row
      WHERE namespace_row.nspname = schema_name
        AND acl_row.grantee = 0
        AND acl_row.privilege_type = 'USAGE'
    ) THEN
      RAISE EXCEPTION 'P5 PUBLIC has USAGE on %', schema_name;
    END IF;

    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)
         AND has_schema_privilege(role_name, schema_name, 'USAGE') THEN
        RAISE EXCEPTION 'P5 % has USAGE on %', role_name, schema_name;
      END IF;
    END LOOP;

    IF has_schema_privilege('letletme_graphql_reader', schema_name, 'CREATE') THEN
      RAISE EXCEPTION 'P5 GraphQL reader has CREATE on %', schema_name;
    END IF;
  END LOOP;

  SELECT count(*) INTO failure_count
  FROM pg_class relation_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops')
    AND relation_row.relkind IN ('r', 'p', 'v', 'm')
    AND (
      has_table_privilege('letletme_graphql_reader', relation_row.oid, 'INSERT')
      OR has_table_privilege('letletme_graphql_reader', relation_row.oid, 'UPDATE')
      OR has_table_privilege('letletme_graphql_reader', relation_row.oid, 'DELETE')
      OR has_table_privilege('letletme_graphql_reader', relation_row.oid, 'TRUNCATE')
    );

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 GraphQL reader write-capable relations: %', failure_count;
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
    RAISE EXCEPTION 'P5 Data writer migration-run preflight privilege boundary failed';
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
    RAISE EXCEPTION 'P5 Data writer reporting refresh/read-model privilege boundary failed';
  END IF;

  FOR role_name IN
    SELECT 'letletme_web_auth'
    UNION ALL
    SELECT login_role.rolname
    FROM pg_auth_members membership
    JOIN pg_roles capability_role ON capability_role.oid = membership.roleid
    JOIN pg_roles login_role ON login_role.oid = membership.member
    WHERE capability_role.rolname = 'letletme_web_auth'
    ORDER BY 1
  LOOP
    FOREACH schema_name IN ARRAY ARRAY[
      'fpl',
      'competition',
      'understat',
      'bridge',
      'reporting',
      'ops'
    ]
    LOOP
      IF has_schema_privilege(role_name, schema_name, 'USAGE')
        OR has_schema_privilege(role_name, schema_name, 'CREATE') THEN
        RAISE EXCEPTION 'P5 Web auth role % can access Data schema %', role_name, schema_name;
      END IF;
    END LOOP;

    SELECT count(*) INTO failure_count
    FROM pg_class relation_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname IN (
      'fpl',
      'competition',
      'understat',
      'bridge',
      'reporting',
      'ops',
      'public'
    )
      AND relation_row.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        has_table_privilege(role_name, relation_row.oid, 'SELECT')
        OR has_table_privilege(role_name, relation_row.oid, 'INSERT')
        OR has_table_privilege(role_name, relation_row.oid, 'UPDATE')
        OR has_table_privilege(role_name, relation_row.oid, 'DELETE')
        OR has_table_privilege(role_name, relation_row.oid, 'TRUNCATE')
        OR has_table_privilege(role_name, relation_row.oid, 'REFERENCES')
        OR has_table_privilege(role_name, relation_row.oid, 'TRIGGER')
      );

    IF failure_count <> 0 THEN
      RAISE EXCEPTION 'P5 Web auth role % has Data/public relation privileges: %',
        role_name,
        failure_count;
    END IF;

    SELECT count(*) INTO failure_count
    FROM pg_class relation_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname IN (
      'fpl',
      'competition',
      'understat',
      'bridge',
      'reporting',
      'ops',
      'public'
    )
      AND relation_row.relkind = 'S'
      AND (
        has_sequence_privilege(role_name, relation_row.oid, 'USAGE')
        OR has_sequence_privilege(role_name, relation_row.oid, 'SELECT')
        OR has_sequence_privilege(role_name, relation_row.oid, 'UPDATE')
      );

    IF failure_count <> 0 THEN
      RAISE EXCEPTION 'P5 Web auth role % has Data/public sequence privileges: %',
        role_name,
        failure_count;
    END IF;

    SELECT count(*) INTO failure_count
    FROM pg_proc function_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname IN (
      'fpl',
      'competition',
      'understat',
      'bridge',
      'reporting',
      'ops'
    )
      AND has_function_privilege(role_name, function_row.oid, 'EXECUTE');

    IF failure_count <> 0 THEN
      RAISE EXCEPTION 'P5 Web auth role % can execute Data functions: %',
        role_name,
        failure_count;
    END IF;
  END LOOP;

  SELECT count(*) INTO failure_count
  FROM pg_class relation_row
  WHERE relation_row.relnamespace = 'reporting'::regnamespace
    AND relation_row.relkind = 'v'
    AND NOT (coalesce(relation_row.reloptions, '{}'::text[]) @> ARRAY['security_invoker=true']);

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'P5 reporting views missing security_invoker: %', failure_count;
  END IF;

  IF (
    SELECT count(*)
    FROM pg_proc function_row
    WHERE function_row.pronamespace = 'reporting'::regnamespace
      AND function_row.prosecdef
      AND function_row.proname IN (
        'refresh_tournament_selection_stats',
        'refresh_tournament_entry_event_summaries'
      )
      AND function_row.proconfig @> ARRAY['search_path=pg_catalog']
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(coalesce(
          function_row.proacl,
          acldefault('f', function_row.proowner)
        )) acl_row
        WHERE acl_row.grantee = 0
          AND acl_row.privilege_type = 'EXECUTE'
      )
  ) <> 2 OR EXISTS (
    SELECT 1
    FROM pg_proc function_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops')
      AND function_row.prosecdef
      AND NOT (
        namespace_row.nspname = 'reporting'
        AND function_row.proname IN (
          'refresh_tournament_selection_stats',
          'refresh_tournament_entry_event_summaries'
        )
      )
  ) THEN
    RAISE EXCEPTION 'P5 SECURITY DEFINER allowlist/search_path/execute contract failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class relation_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname = 'bauth'
      AND relation_row.relkind IN ('r', 'p', 'v', 'm')
      AND (
        has_table_privilege('letletme_data_writer', relation_row.oid, 'INSERT')
        OR has_table_privilege('letletme_data_writer', relation_row.oid, 'UPDATE')
        OR has_table_privilege('letletme_data_writer', relation_row.oid, 'DELETE')
        OR has_table_privilege('letletme_data_writer', relation_row.oid, 'TRUNCATE')
      )
  ) THEN
    RAISE EXCEPTION 'P5 Data writer can mutate bauth';
  END IF;
END
$security_contract$;

SELECT jsonb_build_object(
  'status', 'p5_quality_validation_passed',
  'database', current_database(),
  'completedSeasons', (
    SELECT jsonb_agg(season_code ORDER BY season_code)
    FROM fpl.seasons
    WHERE lifecycle_state = 'completed'
  ),
  'currentSeason', (
    SELECT season_code FROM fpl.seasons WHERE is_current
  ),
  'fplCounts', jsonb_build_object(
    'teams', (SELECT count(*) FROM fpl.teams),
    'events', (SELECT count(*) FROM fpl.events),
    'fixtures', (SELECT count(*) FROM fpl.fixtures),
    'players', (SELECT count(*) FROM fpl.players),
    'playerSummaries', (SELECT count(*) FROM reporting.player_season_summaries)
  ),
  'understatCounts', jsonb_build_object(
    'matches', (SELECT count(*) FROM understat.matches),
    'playerMatchStats', (SELECT count(*) FROM understat.player_match_stats),
    'entityLinks', (SELECT count(*) FROM bridge.entity_links)
  ),
  'migrationChecks', (
    SELECT count(*)
    FROM ops.migration_objects
    WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
      AND status = 'passed'
  ),
  'webRuntimeLogins', (
    SELECT jsonb_agg(login_role.rolname ORDER BY login_role.rolname)
    FROM pg_auth_members membership
    JOIN pg_roles capability_role ON capability_role.oid = membership.roleid
    JOIN pg_roles login_role ON login_role.oid = membership.member
    WHERE capability_role.rolname = 'letletme_web_auth'
  )
) AS p5_quality_summary;

COMMIT;
