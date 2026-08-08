-- Direct provider-boundary conversion plus unified operational audit state.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
SET LOCAL ROLE letletme_data_owner;

INSERT INTO understat.seasons (
  season_code,
  source_year,
  league,
  state,
  first_seen_at,
  last_seen_at,
  created_at,
  updated_at
)
SELECT
  source.season,
  source.source_year,
  source.league,
  source.state::text::understat.season_state,
  source.first_seen_at,
  source.last_seen_at,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.understat_seasons source
ON CONFLICT (season_code) DO NOTHING;

INSERT INTO understat.teams (
  team_id,
  title,
  short_title,
  first_seen_season,
  last_seen_season,
  source_hash,
  created_at,
  updated_at
)
SELECT
  source.id,
  source.title,
  source.short_title,
  source.first_seen_season,
  source.last_seen_season,
  source.source_hash,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.understat_teams source
ON CONFLICT (team_id) DO NOTHING;

INSERT INTO understat.players (
  player_id,
  name,
  favorite_position,
  first_seen_season,
  last_seen_season,
  source_hash,
  created_at,
  updated_at
)
SELECT
  source.id,
  source.name,
  source.favorite_position,
  source.first_seen_season,
  source.last_seen_season,
  source.source_hash,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.understat_players source
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO understat.matches (
  match_id,
  season_code,
  home_team_id,
  away_team_id,
  kickoff_at,
  is_result,
  home_goals,
  away_goals,
  home_xg,
  away_xg,
  forecast_home_win,
  forecast_draw,
  forecast_away_win,
  source_hash,
  source_checked_at,
  last_seen_at,
  created_at,
  updated_at
)
SELECT
  source.id,
  source.season,
  source.home_team_id,
  source.away_team_id,
  source.kickoff_at,
  source.is_result,
  source.home_goals,
  source.away_goals,
  source.home_xg,
  source.away_xg,
  source.forecast_home_win,
  source.forecast_draw,
  source.forecast_away_win,
  source.source_hash,
  source.source_checked_at,
  source.last_seen_at,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.understat_matches source
ON CONFLICT (match_id) DO NOTHING;

INSERT INTO understat.team_match_stats (
  match_id,
  team_id,
  side,
  xg,
  xga,
  npxg,
  npxga,
  npxgd,
  ppda_att,
  ppda_def,
  ppda_allowed_att,
  ppda_allowed_def,
  deep,
  deep_allowed,
  scored,
  missed,
  xpoints,
  result,
  points,
  wins,
  draws,
  losses,
  source_hash,
  created_at,
  updated_at
)
SELECT
  source.match_id,
  source.team_id,
  source.side,
  source.xg,
  source.xga,
  source.npxg,
  source.npxga,
  source.npxgd,
  source.ppda_att,
  source.ppda_def,
  source.ppda_allowed_att,
  source.ppda_allowed_def,
  source.deep,
  source.deep_allowed,
  source.scored,
  source.missed,
  source.xpoints,
  source.result,
  source.points,
  source.wins,
  source.draws,
  source.losses,
  source.source_hash,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.understat_team_match_stats source
ON CONFLICT (match_id, team_id) DO NOTHING;

INSERT INTO understat.team_seasons (
  season_code,
  team_id,
  source_title,
  source_short_title,
  games,
  wins,
  draws,
  losses,
  goals_for,
  goals_against,
  points,
  xg,
  xga,
  npxg,
  npxga,
  npxgd,
  xpoints,
  deep,
  deep_allowed,
  ppda_att,
  ppda_def,
  ppda_allowed_att,
  ppda_allowed_def,
  source_hash,
  last_synced_at,
  created_at,
  updated_at
)
SELECT
  source.season,
  source.team_id,
  source.source_title,
  source.source_short_title,
  source.games,
  source.wins,
  source.draws,
  source.losses,
  source.goals_for,
  source.goals_against,
  source.points,
  source.xg,
  source.xga,
  source.npxg,
  source.npxga,
  source.npxgd,
  source.xpoints,
  source.deep,
  source.deep_allowed,
  source.ppda_att,
  source.ppda_def,
  source.ppda_allowed_att,
  source.ppda_allowed_def,
  source.source_hash,
  source.last_synced_at,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.understat_team_seasons source
ON CONFLICT (season_code, team_id) DO NOTHING;

INSERT INTO understat.team_stat_splits (
  season_code,
  team_id,
  dimension,
  split_key,
  label,
  time_minutes,
  shots_for,
  goals_for,
  xg_for,
  shots_against,
  goals_against,
  xg_against,
  source_hash,
  created_at,
  updated_at
)
SELECT
  source.season,
  source.team_id,
  source.dimension,
  source.split_key,
  source.label,
  source.time_minutes,
  source.shots_for,
  source.goals_for,
  source.xg_for,
  source.shots_against,
  source.goals_against,
  source.xg_against,
  source.source_hash,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.understat_team_stat_splits source
ON CONFLICT (season_code, team_id, dimension, split_key) DO NOTHING;

INSERT INTO understat.player_seasons (
  season_code,
  player_id,
  source_name,
  source_team_title,
  games,
  time_minutes,
  goals,
  non_penalty_goals,
  assists,
  shots,
  key_passes,
  yellow_cards,
  red_cards,
  xg,
  non_penalty_xg,
  xa,
  xg_chain,
  xg_buildup,
  position,
  source_hash,
  created_at,
  updated_at
)
SELECT
  source.season,
  source.player_id,
  source.source_name,
  source.source_team_title,
  source.games,
  source.time,
  source.goals,
  source.npg,
  source.assists,
  source.shots,
  source.key_passes,
  source.yellow_cards,
  source.red_cards,
  source.xg,
  source.npxg,
  source.xa,
  source.xg_chain,
  source.xg_buildup,
  source.position,
  source.source_hash,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.understat_player_seasons source
ON CONFLICT (season_code, player_id) DO NOTHING;

INSERT INTO understat.player_team_seasons (
  season_code,
  player_id,
  team_id,
  games,
  time_minutes,
  goals,
  non_penalty_goals,
  assists,
  shots,
  key_passes,
  yellow_cards,
  red_cards,
  xg,
  non_penalty_xg,
  xa,
  xg_chain,
  xg_buildup,
  position,
  source_hash,
  created_at,
  updated_at
)
SELECT
  source.season,
  source.player_id,
  source.team_id,
  source.games,
  source.time,
  source.goals,
  source.npg,
  source.assists,
  source.shots,
  source.key_passes,
  source.yellow_cards,
  source.red_cards,
  source.xg,
  source.npxg,
  source.xa,
  source.xg_chain,
  source.xg_buildup,
  source.position,
  source.source_hash,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.understat_player_team_seasons source
ON CONFLICT (season_code, player_id, team_id) DO NOTHING;

INSERT INTO understat.player_match_stats (
  roster_id,
  match_id,
  player_id,
  team_id,
  player_name,
  side,
  position,
  position_order,
  minutes,
  started,
  goals,
  own_goals,
  shots,
  key_passes,
  assists,
  yellow_cards,
  red_cards,
  xg,
  xa,
  xg_chain,
  xg_buildup,
  roster_in_id,
  roster_out_id,
  source_hash,
  created_at,
  updated_at
)
SELECT
  source.roster_id,
  source.match_id,
  source.player_id,
  source.team_id,
  source.player_name,
  source.side,
  source.position,
  source.position_order,
  source.minutes,
  source.started,
  source.goals,
  source.own_goals,
  source.shots,
  source.key_passes,
  source.assists,
  source.yellow_cards,
  source.red_cards,
  source.xg,
  source.xa,
  source.xg_chain,
  source.xg_buildup,
  source.roster_in_id,
  source.roster_out_id,
  source.source_hash,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.understat_player_match_stats source
ON CONFLICT (roster_id) DO NOTHING;

INSERT INTO bridge.entity_links (
  link_id,
  entity_type,
  left_provider,
  left_entity_id,
  right_provider,
  right_entity_id,
  status,
  method,
  rule_version,
  evidence,
  first_seen_season,
  last_seen_season,
  reviewed_by,
  reviewed_at,
  created_at,
  updated_at
)
SELECT
  source.id,
  source.entity_type::text::bridge.entity_type,
  source.left_provider,
  source.left_entity_id,
  source.right_provider,
  source.right_entity_id,
  source.status::text::bridge.link_status,
  source.method,
  source.rule_version,
  source.evidence,
  source.first_seen_season,
  source.last_seen_season,
  source.reviewed_by,
  source.reviewed_at,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.provider_entity_links source
ON CONFLICT (link_id) DO NOTHING;

INSERT INTO bridge.match_links (
  link_id,
  season_code,
  left_provider,
  left_match_id,
  right_provider,
  right_match_id,
  status,
  method,
  rule_version,
  evidence,
  reviewed_by,
  reviewed_at,
  created_at,
  updated_at
)
SELECT
  source.id,
  source.season,
  source.left_provider,
  source.left_match_id,
  source.right_provider,
  source.right_match_id,
  source.status::text::bridge.link_status,
  source.method,
  source.rule_version,
  source.evidence,
  source.reviewed_by,
  source.reviewed_at,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.provider_match_links source
ON CONFLICT (link_id) DO NOTHING;

INSERT INTO bridge.entity_aliases (
  alias_id,
  entity_type,
  provider,
  provider_entity_id,
  alias,
  source,
  first_observed_at,
  last_observed_at,
  created_at,
  updated_at
)
SELECT
  source.id,
  source.entity_type::text::bridge.entity_type,
  source.provider,
  source.provider_entity_id,
  source.alias,
  source.source,
  source.first_observed_at,
  source.last_observed_at,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.provider_entity_aliases source
ON CONFLICT (alias_id) DO NOTHING;

INSERT INTO ops.sync_runs (
  run_id,
  provider,
  lane,
  scope,
  season_id,
  season_code,
  event_id,
  mode,
  trigger,
  status,
  expected_items,
  completed_items,
  failed_items,
  skipped_items,
  data_changed,
  publication_id,
  error_summary,
  metadata,
  started_at,
  completed_at,
  created_at,
  updated_at
)
SELECT
  source.run_id,
  'understat',
  source.lane::text,
  'understat.' || source.lane::text,
  season.season_id,
  source.season,
  NULL,
  source.mode::text,
  source.trigger::text,
  source.status::text,
  source.expected_items,
  source.completed_items,
  source.failed_items,
  source.skipped_items,
  source.data_changed,
  NULL,
  source.error_summary,
  jsonb_strip_nulls(jsonb_build_object(
    'legacy_cache_revision', source.cache_revision,
    'legacy_publication_skip_reason', source.publication_skip_reason
  )),
  source.started_at,
  source.completed_at,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.understat_sync_runs source
LEFT JOIN fpl.seasons season ON season.season_code = source.season
ON CONFLICT (run_id) DO NOTHING;

INSERT INTO ops.sync_items (
  run_id,
  resource_type,
  resource_id,
  status,
  attempts,
  source_hash,
  normalized_payload,
  last_error,
  completed_at,
  created_at,
  updated_at
)
SELECT
  source.run_id,
  source.resource_type,
  source.resource_id,
  source.status::text,
  source.attempts,
  source.source_hash,
  NULL,
  source.last_error,
  source.completed_at,
  source.created_at,
  COALESCE(source.completed_at, source.created_at)
FROM public.understat_sync_items source
ON CONFLICT (run_id, resource_type, resource_id) DO NOTHING;

INSERT INTO ops.season_imports (
  season_id,
  season_code,
  status,
  reason,
  source_core_revision,
  item_manifest,
  started_at,
  completed_at,
  error_summary,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  archive.season,
  archive.status::text,
  archive.reason,
  archive.source_core_revision,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'source_table', item.source_table,
        'archive_table', item.archive_table,
        'row_count', item.row_count,
        'canonical_checksum', item.canonical_checksum,
        'verified_at', item.verified_at
      ) ORDER BY item.source_table
    ) FILTER (WHERE item.source_table IS NOT NULL),
    '[]'::jsonb
  ),
  archive.started_at,
  archive.completed_at,
  archive.error_summary,
  archive.created_at,
  COALESCE(archive.updated_at, archive.created_at)
FROM public.fpl_season_archives archive
JOIN fpl.seasons season ON season.season_code = archive.season
LEFT JOIN public.fpl_season_archive_items item ON item.season = archive.season
GROUP BY
  season.season_id,
  archive.season,
  archive.status,
  archive.reason,
  archive.source_core_revision,
  archive.started_at,
  archive.completed_at,
  archive.error_summary,
  archive.created_at,
  archive.updated_at
ON CONFLICT (season_id) DO NOTHING;

INSERT INTO ops.dataset_publications (
  publication_id,
  dataset,
  season_id,
  event_id,
  revision,
  status,
  manifest,
  source_run_id,
  activated_at,
  retired_at,
  expires_at,
  created_at,
  updated_at
)
SELECT
  source.publication_id,
  'fpl:core',
  season.season_id,
  NULL,
  source.revision,
  'active',
  jsonb_build_object('legacy_singleton_id', source.singleton_id),
  NULL,
  source.committed_at,
  NULL,
  NULL,
  source.committed_at,
  source.committed_at
FROM public.core_snapshot_authority source
JOIN fpl.seasons season ON season.season_code = source.season
ON CONFLICT (publication_id) DO NOTHING;

INSERT INTO ops.schema_migrations (filename, checksum, applied_at)
SELECT source.filename, source.checksum, source.applied_at
FROM public.sql_migrations source
ON CONFLICT (filename) DO UPDATE SET
  checksum = EXCLUDED.checksum,
  applied_at = EXCLUDED.applied_at;

DO $legacy_graphql_ledger$
DECLARE
  legacy_count bigint;
BEGIN
  IF to_regclass('public.graphql_schema_migrations') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.graphql_schema_migrations' INTO legacy_count;
  IF legacy_count = 0 THEN
    RETURN;
  END IF;

  INSERT INTO ops.migration_runs (
    run_id,
    plan_version,
    source_project,
    source_postgres_version,
    source_data_sha,
    status,
    started_at,
    metadata
  )
  VALUES (
    'v3-20260808T160008Z-b9eddc0',
    '3.1.1',
    'gtwcfjoviibmtkevurjw',
    '15.8',
    'b9eddc0',
    'running',
    now(),
    jsonb_build_object('purpose', 'production B0 upgrade replay')
  )
  ON CONFLICT (run_id) DO NOTHING;

  EXECUTE $copy_graphql$
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
      status,
      executed_at
    )
    SELECT
      'v3-20260808T160008Z-b9eddc0',
      'legacy_graphql_migration:' || source.version,
      'public.graphql_schema_migrations',
      'ops.migration_objects',
      source.checksum,
      1,
      1,
      source.checksum,
      source.checksum,
      0,
      '[]'::jsonb,
      'passed',
      source.applied_at
    FROM public.graphql_schema_migrations source
    ON CONFLICT (run_id, check_name, source_object, target_object) DO NOTHING
  $copy_graphql$;
END
$legacy_graphql_ledger$;

DO $publication_sequence$
DECLARE
  maximum_revision bigint;
BEGIN
  SELECT max(revision) INTO maximum_revision FROM ops.dataset_publications;
  IF maximum_revision IS NOT NULL THEN
    PERFORM setval('ops.dataset_publication_revisions', maximum_revision, true);
  END IF;
END
$publication_sequence$;

DO $understat_ops_count_reconciliation$
DECLARE
  source_count bigint;
  target_count bigint;
BEGIN
  SELECT count(*) INTO source_count FROM public.understat_seasons;
  SELECT count(*) INTO target_count FROM understat.seasons;
  IF source_count <> target_count THEN RAISE EXCEPTION 'understat.seasons count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.understat_teams;
  SELECT count(*) INTO target_count FROM understat.teams;
  IF source_count <> target_count THEN RAISE EXCEPTION 'understat.teams count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.understat_players;
  SELECT count(*) INTO target_count FROM understat.players;
  IF source_count <> target_count THEN RAISE EXCEPTION 'understat.players count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.understat_matches;
  SELECT count(*) INTO target_count FROM understat.matches;
  IF source_count <> target_count THEN RAISE EXCEPTION 'understat.matches count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.understat_team_match_stats;
  SELECT count(*) INTO target_count FROM understat.team_match_stats;
  IF source_count <> target_count THEN RAISE EXCEPTION 'understat.team_match_stats count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.understat_team_seasons;
  SELECT count(*) INTO target_count FROM understat.team_seasons;
  IF source_count <> target_count THEN RAISE EXCEPTION 'understat.team_seasons count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.understat_team_stat_splits;
  SELECT count(*) INTO target_count FROM understat.team_stat_splits;
  IF source_count <> target_count THEN RAISE EXCEPTION 'understat.team_stat_splits count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.understat_player_seasons;
  SELECT count(*) INTO target_count FROM understat.player_seasons;
  IF source_count <> target_count THEN RAISE EXCEPTION 'understat.player_seasons count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.understat_player_team_seasons;
  SELECT count(*) INTO target_count FROM understat.player_team_seasons;
  IF source_count <> target_count THEN RAISE EXCEPTION 'understat.player_team_seasons count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.understat_player_match_stats;
  SELECT count(*) INTO target_count FROM understat.player_match_stats;
  IF source_count <> target_count THEN RAISE EXCEPTION 'understat.player_match_stats count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.provider_entity_links;
  SELECT count(*) INTO target_count FROM bridge.entity_links;
  IF source_count <> target_count THEN RAISE EXCEPTION 'bridge.entity_links count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.provider_match_links;
  SELECT count(*) INTO target_count FROM bridge.match_links;
  IF source_count <> target_count THEN RAISE EXCEPTION 'bridge.match_links count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.provider_entity_aliases;
  SELECT count(*) INTO target_count FROM bridge.entity_aliases;
  IF source_count <> target_count THEN RAISE EXCEPTION 'bridge.entity_aliases count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.understat_sync_runs;
  SELECT count(*) INTO target_count FROM ops.sync_runs WHERE provider = 'understat';
  IF source_count <> target_count THEN RAISE EXCEPTION 'ops.sync_runs count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.understat_sync_items;
  SELECT count(*) INTO target_count
  FROM ops.sync_items item
  JOIN ops.sync_runs run ON run.run_id = item.run_id
  WHERE run.provider = 'understat';
  IF source_count <> target_count THEN RAISE EXCEPTION 'ops.sync_items count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.fpl_season_archives;
  SELECT count(*) INTO target_count FROM ops.season_imports;
  IF source_count <> target_count THEN RAISE EXCEPTION 'ops.season_imports count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.core_snapshot_authority;
  SELECT count(*) INTO target_count FROM ops.dataset_publications WHERE dataset = 'fpl:core';
  IF source_count <> target_count THEN RAISE EXCEPTION 'ops.dataset_publications count mismatch'; END IF;

  SELECT count(*) INTO source_count FROM public.sql_migrations;
  SELECT count(*) INTO target_count FROM ops.schema_migrations;
  IF source_count <> target_count THEN RAISE EXCEPTION 'ops.schema_migrations count mismatch'; END IF;
END
$understat_ops_count_reconciliation$;

CREATE TEMPORARY TABLE v3_provider_ops_reconciliation_specs (
  check_name text PRIMARY KEY,
  source_object text NOT NULL,
  target_object text NOT NULL,
  source_query text NOT NULL,
  target_query text NOT NULL
) ON COMMIT DROP;

INSERT INTO v3_provider_ops_reconciliation_specs (
  check_name,
  source_object,
  target_object,
  source_query,
  target_query
)
VALUES
  (
    '0087_understat_seasons_rows',
    'public.understat_seasons',
    'understat.seasons',
    $source$SELECT jsonb_build_array(
        season, source_year, league, state::text
      )::text AS canonical_row
      FROM public.understat_seasons$source$,
    $target$SELECT jsonb_build_array(
        season_code, source_year, league, state::text
      )::text AS canonical_row
      FROM understat.seasons$target$
  ),
  (
    '0087_understat_teams_source_hash',
    'public.understat_teams',
    'understat.teams',
    $source$SELECT jsonb_build_array(id, source_hash)::text AS canonical_row
      FROM public.understat_teams$source$,
    $target$SELECT jsonb_build_array(team_id, source_hash)::text AS canonical_row
      FROM understat.teams$target$
  ),
  (
    '0087_understat_players_source_hash',
    'public.understat_players',
    'understat.players',
    $source$SELECT jsonb_build_array(id, source_hash)::text AS canonical_row
      FROM public.understat_players$source$,
    $target$SELECT jsonb_build_array(player_id, source_hash)::text AS canonical_row
      FROM understat.players$target$
  ),
  (
    '0087_understat_matches_source_hash',
    'public.understat_matches',
    'understat.matches',
    $source$SELECT jsonb_build_array(id, source_hash)::text AS canonical_row
      FROM public.understat_matches$source$,
    $target$SELECT jsonb_build_array(match_id, source_hash)::text AS canonical_row
      FROM understat.matches$target$
  ),
  (
    '0087_understat_team_match_stats_source_hash',
    'public.understat_team_match_stats',
    'understat.team_match_stats',
    $source$SELECT jsonb_build_array(match_id, team_id, source_hash)::text AS canonical_row
      FROM public.understat_team_match_stats$source$,
    $target$SELECT jsonb_build_array(match_id, team_id, source_hash)::text AS canonical_row
      FROM understat.team_match_stats$target$
  ),
  (
    '0087_understat_team_seasons_source_hash',
    'public.understat_team_seasons',
    'understat.team_seasons',
    $source$SELECT jsonb_build_array(season, team_id, source_hash)::text AS canonical_row
      FROM public.understat_team_seasons$source$,
    $target$SELECT jsonb_build_array(season_code, team_id, source_hash)::text AS canonical_row
      FROM understat.team_seasons$target$
  ),
  (
    '0087_understat_team_stat_splits_source_hash',
    'public.understat_team_stat_splits',
    'understat.team_stat_splits',
    $source$SELECT jsonb_build_array(
        season, team_id, dimension, split_key, source_hash
      )::text AS canonical_row
      FROM public.understat_team_stat_splits$source$,
    $target$SELECT jsonb_build_array(
        season_code, team_id, dimension, split_key, source_hash
      )::text AS canonical_row
      FROM understat.team_stat_splits$target$
  ),
  (
    '0087_understat_player_seasons_source_hash',
    'public.understat_player_seasons',
    'understat.player_seasons',
    $source$SELECT jsonb_build_array(season, player_id, source_hash)::text AS canonical_row
      FROM public.understat_player_seasons$source$,
    $target$SELECT jsonb_build_array(season_code, player_id, source_hash)::text AS canonical_row
      FROM understat.player_seasons$target$
  ),
  (
    '0087_understat_player_team_seasons_source_hash',
    'public.understat_player_team_seasons',
    'understat.player_team_seasons',
    $source$SELECT jsonb_build_array(
        season, player_id, team_id, source_hash
      )::text AS canonical_row
      FROM public.understat_player_team_seasons$source$,
    $target$SELECT jsonb_build_array(
        season_code, player_id, team_id, source_hash
      )::text AS canonical_row
      FROM understat.player_team_seasons$target$
  ),
  (
    '0087_understat_player_match_stats_source_hash',
    'public.understat_player_match_stats',
    'understat.player_match_stats',
    $source$SELECT jsonb_build_array(roster_id, source_hash)::text AS canonical_row
      FROM public.understat_player_match_stats$source$,
    $target$SELECT jsonb_build_array(roster_id, source_hash)::text AS canonical_row
      FROM understat.player_match_stats$target$
  ),
  (
    '0087_bridge_entity_links_rows',
    'public.provider_entity_links',
    'bridge.entity_links',
    $source$SELECT jsonb_build_array(
        id, status::text, method, rule_version, evidence
      )::text AS canonical_row
      FROM public.provider_entity_links$source$,
    $target$SELECT jsonb_build_array(
        link_id, status::text, method, rule_version, evidence
      )::text AS canonical_row
      FROM bridge.entity_links$target$
  ),
  (
    '0087_bridge_match_links_rows',
    'public.provider_match_links',
    'bridge.match_links',
    $source$SELECT jsonb_build_array(
        id, season, status::text, method, rule_version, evidence
      )::text AS canonical_row
      FROM public.provider_match_links$source$,
    $target$SELECT jsonb_build_array(
        link_id, season_code, status::text, method, rule_version, evidence
      )::text AS canonical_row
      FROM bridge.match_links$target$
  ),
  (
    '0087_bridge_entity_aliases_rows',
    'public.provider_entity_aliases',
    'bridge.entity_aliases',
    $source$SELECT jsonb_build_array(
        id, entity_type::text, provider, provider_entity_id, alias, source
      )::text AS canonical_row
      FROM public.provider_entity_aliases$source$,
    $target$SELECT jsonb_build_array(
        alias_id, entity_type::text, provider, provider_entity_id, alias, source
      )::text AS canonical_row
      FROM bridge.entity_aliases$target$
  ),
  (
    '0087_ops_understat_sync_runs_keyset',
    'public.understat_sync_runs',
    'ops.sync_runs',
    $source$SELECT run_id::text AS canonical_row FROM public.understat_sync_runs$source$,
    $target$SELECT run_id::text AS canonical_row
      FROM ops.sync_runs WHERE provider = 'understat'$target$
  ),
  (
    '0087_ops_understat_sync_items_source_hash',
    'public.understat_sync_items',
    'ops.sync_items',
    $source$SELECT jsonb_build_array(
        run_id, resource_type, resource_id, source_hash
      )::text AS canonical_row
      FROM public.understat_sync_items$source$,
    $target$SELECT jsonb_build_array(
        item.run_id, item.resource_type, item.resource_id, item.source_hash
      )::text AS canonical_row
      FROM ops.sync_items item
      JOIN ops.sync_runs run ON run.run_id = item.run_id
      WHERE run.provider = 'understat'$target$
  ),
  (
    '0087_ops_season_imports_keyset',
    'public.fpl_season_archives',
    'ops.season_imports',
    $source$SELECT season::text AS canonical_row FROM public.fpl_season_archives$source$,
    $target$SELECT season_code::text AS canonical_row FROM ops.season_imports$target$
  ),
  (
    '0087_ops_dataset_publications_keyset',
    'public.core_snapshot_authority',
    'ops.dataset_publications',
    $source$SELECT jsonb_build_array(publication_id, revision)::text AS canonical_row
      FROM public.core_snapshot_authority$source$,
    $target$SELECT jsonb_build_array(publication_id, revision)::text AS canonical_row
      FROM ops.dataset_publications WHERE dataset = 'fpl:core'$target$
  ),
  (
    '0087_ops_schema_migrations_rows',
    'public.sql_migrations',
    'ops.schema_migrations',
    $source$SELECT jsonb_build_array(filename, checksum, applied_at)::text AS canonical_row
      FROM public.sql_migrations$source$,
    $target$SELECT jsonb_build_array(filename, checksum, applied_at)::text AS canonical_row
      FROM ops.schema_migrations$target$
  );

DO $record_provider_ops_reconciliation_evidence$
DECLARE
  spec record;
  source_count bigint;
  source_hash text;
  target_count bigint;
  target_hash text;
BEGIN
  FOR spec IN SELECT * FROM v3_provider_ops_reconciliation_specs ORDER BY check_name
  LOOP
    EXECUTE format(
      $hash_query$
        SELECT
          count(*)::bigint,
          encode(
            sha256(convert_to(
              coalesce(string_agg(canonical_row, E'\n' ORDER BY canonical_row), ''),
              'UTF8'
            )),
            'hex'
          )
        FROM (%s) evidence_rows
      $hash_query$,
      spec.source_query
    ) INTO source_count, source_hash;

    EXECUTE format(
      $hash_query$
        SELECT
          count(*)::bigint,
          encode(
            sha256(convert_to(
              coalesce(string_agg(canonical_row, E'\n' ORDER BY canonical_row), ''),
              'UTF8'
            )),
            'hex'
          )
        FROM (%s) evidence_rows
      $hash_query$,
      spec.target_query
    ) INTO target_count, target_hash;

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
    VALUES (
      'v3-20260808T160008Z-b9eddc0',
      spec.check_name,
      spec.source_object,
      spec.target_object,
      encode(sha256(convert_to(
        spec.source_query || E'\n-- target --\n' || spec.target_query,
        'UTF8'
      )), 'hex'),
      source_count,
      target_count,
      source_hash,
      target_hash,
      CASE WHEN source_count = target_count AND source_hash = target_hash THEN 0 ELSE 1 END,
      '[]'::jsonb,
      CASE
        WHEN source_count = target_count AND source_hash = target_hash THEN 'passed'
        ELSE 'failed'
      END
    )
    ON CONFLICT (run_id, check_name, source_object, target_object) DO UPDATE SET
      query_sha256 = EXCLUDED.query_sha256,
      source_row_count = EXCLUDED.source_row_count,
      target_row_count = EXCLUDED.target_row_count,
      source_hash = EXCLUDED.source_hash,
      target_hash = EXCLUDED.target_hash,
      failed_count = EXCLUDED.failed_count,
      sample_failed_keys = EXCLUDED.sample_failed_keys,
      status = EXCLUDED.status,
      executed_at = now();

    IF source_count <> target_count OR source_hash <> target_hash THEN
      RAISE EXCEPTION 'provider/ops reconciliation failed for %: source %/%, target %/%',
        spec.check_name,
        source_count,
        source_hash,
        target_count,
        target_hash;
    END IF;
  END LOOP;
END
$record_provider_ops_reconciliation_evidence$;

ANALYZE understat.seasons;
ANALYZE understat.teams;
ANALYZE understat.players;
ANALYZE understat.matches;
ANALYZE understat.team_match_stats;
ANALYZE understat.team_seasons;
ANALYZE understat.team_stat_splits;
ANALYZE understat.player_seasons;
ANALYZE understat.player_team_seasons;
ANALYZE understat.player_match_stats;
ANALYZE bridge.entity_links;
ANALYZE bridge.match_links;
ANALYZE bridge.entity_aliases;
ANALYZE ops.sync_runs;
ANALYZE ops.sync_items;
ANALYZE ops.season_imports;
ANALYZE ops.dataset_publications;

RESET ROLE;
