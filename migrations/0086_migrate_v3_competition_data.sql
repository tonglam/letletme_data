-- Convert entry, league, and tournament facts into season-aware v3 tables.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL ROLE letletme_data_owner;

INSERT INTO competition.entries (
  season_id,
  entry_id,
  entry_name,
  player_name,
  region,
  started_event,
  overall_points,
  overall_rank,
  bank,
  team_value,
  total_transfers,
  last_entry_name,
  last_overall_points,
  last_overall_rank,
  last_team_value,
  last_bank,
  used_entry_names,
  last_event_id,
  snapshot_synced_through_event_id,
  transfers_synced_through_event_id,
  transfers_source_checked_at,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.id,
  source.entry_name,
  source.player_name,
  source.region,
  source.started_event,
  source.overall_points,
  source.overall_rank,
  source.bank,
  source.team_value,
  source.total_transfers,
  source.last_entry_name,
  source.last_overall_points,
  source.last_overall_rank,
  source.last_team_value,
  source.last_bank,
  source.used_entry_names,
  COALESCE(source.last_event_id, 0),
  source.entry_snapshot_synced_through_event_id,
  source.entry_transfers_synced_through_event_id,
  source.entry_transfers_source_checked_at,
  source.created_at,
  source.updated_at
FROM public.entry_infos source
JOIN fpl.seasons season
  ON season.season_code = COALESCE(
    NULLIF(source.entry_snapshot_synced_season, ''),
    NULLIF(source.entry_transfers_synced_season, ''),
    '2627'
  )
ON CONFLICT (season_id, entry_id) DO NOTHING;

INSERT INTO competition.entry_season_histories (
  season_id,
  entry_id,
  source_history_id,
  source_season_label,
  total_points,
  overall_rank,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.entry_id,
  source.id,
  btrim(source.season),
  source.total_points,
  source.overall_rank,
  source.created_at,
  source.updated_at
FROM public.entry_history_infos source
JOIN fpl.seasons season ON season.display_name = btrim(source.season)
ON CONFLICT (season_id, entry_id) DO NOTHING;

INSERT INTO competition.entry_leagues (
  season_id,
  entry_id,
  league_id,
  league_type,
  source_entry_league_id,
  league_name,
  started_event,
  entry_rank,
  entry_last_rank,
  created_at,
  updated_at
)
SELECT
  entry.season_id,
  source.entry_id,
  source.league_id,
  source.league_type::text::competition.league_type,
  source.id,
  source.league_name,
  source.started_event,
  source.entry_rank,
  source.entry_last_rank,
  source.created_at,
  source.updated_at
FROM public.entry_league_infos source
JOIN competition.entries entry ON entry.entry_id = source.entry_id
ON CONFLICT (season_id, entry_id, league_id, league_type) DO NOTHING;

WITH source_pick_sets AS (
  SELECT DISTINCT ON (source.season_id, source.entry_id, source.event_id)
    source.*
  FROM (
    SELECT
      entry.season_id,
      source.entry_id,
      source.event_id,
      source.id AS source_pick_row_id,
      source.chip::text AS active_chip,
      source.transfers,
      source.transfers_cost,
      source.picks,
      source.created_at,
      source.updated_at,
      1 AS source_priority
    FROM public.entry_event_picks source
    JOIN competition.entries entry ON entry.entry_id = source.entry_id
    WHERE jsonb_typeof(source.picks) = 'array'

    UNION ALL

    SELECT
      entry.season_id,
      source.entry_id,
      source.event_id,
      source.id,
      COALESCE(source.event_chip::text, 'n/a'),
      source.event_transfers,
      source.event_transfers_cost,
      source.event_picks,
      source.created_at,
      source.updated_at,
      2
    FROM public.entry_event_results source
    JOIN competition.entries entry ON entry.entry_id = source.entry_id
    WHERE jsonb_typeof(source.event_picks) = 'array'
  ) source
  ORDER BY source.season_id, source.entry_id, source.event_id, source.source_priority
), normalized_picks AS (
  SELECT
    source.season_id,
    source.entry_id,
    source.event_id,
    (pick.item ->> 'position')::smallint AS position,
    (pick.item ->> 'element')::integer AS element_id,
    (pick.item ->> 'multiplier')::smallint AS multiplier,
    COALESCE((pick.item ->> 'is_captain')::boolean, false) AS is_captain,
    COALESCE((pick.item ->> 'is_vice_captain')::boolean, false) AS is_vice_captain,
    CASE
      WHEN (pick.item ->> 'position')::integer = 1
      THEN source.active_chip::competition.chip
      ELSE NULL
    END AS active_chip,
    CASE WHEN (pick.item ->> 'position')::integer = 1 THEN source.transfers ELSE NULL END
      AS transfers,
    CASE WHEN (pick.item ->> 'position')::integer = 1 THEN source.transfers_cost ELSE NULL END
      AS transfers_cost,
    source.source_pick_row_id,
    source.created_at,
    source.updated_at
  FROM source_pick_sets source
  CROSS JOIN LATERAL jsonb_array_elements(source.picks) AS pick(item)
)
INSERT INTO competition.entry_event_picks (
  season_id,
  entry_id,
  event_id,
  position,
  element_id,
  multiplier,
  is_captain,
  is_vice_captain,
  active_chip,
  transfers,
  transfers_cost,
  source_pick_row_id,
  source_created_at,
  source_updated_at
)
SELECT
  season_id,
  entry_id,
  event_id,
  position,
  element_id,
  multiplier,
  is_captain,
  is_vice_captain,
  active_chip,
  transfers,
  transfers_cost,
  source_pick_row_id,
  created_at,
  updated_at
FROM normalized_picks
ON CONFLICT (season_id, entry_id, event_id, position) DO NOTHING;

INSERT INTO competition.entry_event_results (
  season_id,
  entry_id,
  event_id,
  source_result_id,
  event_points,
  event_transfers,
  event_transfers_cost,
  event_net_points,
  event_bench_points,
  event_auto_sub_points,
  event_rank,
  event_chip,
  played_captain_element_id,
  captain_points,
  automatic_substitutions,
  overall_points,
  overall_rank,
  team_value,
  bank,
  rich_synced_at,
  created_at,
  updated_at
)
SELECT
  entry.season_id,
  source.entry_id,
  source.event_id,
  source.id,
  source.event_points,
  source.event_transfers,
  source.event_transfers_cost,
  source.event_net_points,
  source.event_bench_points,
  source.event_auto_sub_points,
  source.event_rank,
  source.event_chip::text::competition.chip,
  source.event_played_captain,
  source.event_captain_points,
  source.event_auto_sub,
  source.overall_points,
  source.overall_rank,
  source.team_value,
  source.bank,
  source.rich_synced_at,
  source.created_at,
  source.updated_at
FROM public.entry_event_results source
JOIN competition.entries entry ON entry.entry_id = source.entry_id
ON CONFLICT (season_id, entry_id, event_id) DO NOTHING;

INSERT INTO competition.entry_event_transfers (
  season_id,
  transfer_id,
  entry_id,
  event_id,
  element_in_id,
  element_in_cost,
  element_in_points,
  element_out_id,
  element_out_cost,
  element_out_points,
  element_in_played,
  transfer_time,
  created_at,
  updated_at
)
SELECT
  entry.season_id,
  source.id,
  source.entry_id,
  source.event_id,
  source.element_in_id,
  source.element_in_cost,
  source.element_in_points,
  source.element_out_id,
  source.element_out_cost,
  source.element_out_points,
  source.element_in_played,
  source.transfer_time,
  source.created_at,
  source.updated_at
FROM public.entry_event_transfers source
JOIN competition.entries entry ON entry.entry_id = source.entry_id
ON CONFLICT (season_id, transfer_id) DO NOTHING;

INSERT INTO competition.entry_event_cup_results (
  season_id,
  source_result_id,
  entry_id,
  event_id,
  opponent_entry_id,
  opponent_name,
  result,
  entry_points,
  opponent_points,
  entry_name,
  player_name,
  against_entry_name,
  against_player_name,
  event_points,
  against_entry_id,
  against_event_points,
  source_season_code,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.id,
  source.entry_id,
  source.event_id,
  source.opponent_entry_id,
  source.opponent_name,
  source.result::text::competition.cup_result,
  source.entry_points,
  source.opponent_points,
  source.entry_name,
  source.player_name,
  source.against_entry_name,
  source.against_player_name,
  source.event_points,
  source.against_entry_id,
  source.against_event_points,
  source.source_season,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.entry_event_cup_results source
JOIN fpl.seasons season ON season.season_code = COALESCE(NULLIF(source.source_season, ''), '2627')
ON CONFLICT (season_id, source_result_id) DO NOTHING;

INSERT INTO competition.league_event_results (
  season_id,
  source_result_id,
  league_id,
  league_type,
  entry_id,
  event_id,
  event_points,
  event_transfers,
  event_transfers_cost,
  event_net_points,
  overall_points,
  overall_rank,
  entry_name,
  player_name,
  team_value,
  bank,
  event_bench_points,
  event_auto_sub_points,
  event_rank,
  event_chip,
  captain_element_id,
  captain_points,
  captain_blank,
  vice_captain_element_id,
  vice_captain_points,
  vice_captain_blank,
  played_captain_element_id,
  highest_score_element_id,
  highest_score_points,
  highest_score_blank,
  source_checked_at,
  created_at,
  updated_at
)
SELECT
  entry.season_id,
  source.id,
  source.league_id,
  source.league_type::text::competition.league_type,
  source.entry_id,
  source.event_id,
  source.event_points,
  source.event_transfers,
  source.event_transfers_cost,
  source.event_net_points,
  source.overall_points,
  source.overall_rank,
  source.entry_name,
  source.player_name,
  source.team_value,
  source.bank,
  source.event_bench_points,
  source.event_auto_sub_points,
  source.event_rank,
  source.event_chip::text::competition.chip,
  source.captain_id,
  source.captain_points,
  source.captain_blank,
  source.vice_captain_id,
  source.vice_captain_points,
  source.vice_captain_blank,
  source.played_captain_id,
  source.highest_score_element_id,
  source.highest_score_points,
  source.highest_score_blank,
  source.source_checked_at,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM public.league_event_results source
JOIN competition.entries entry ON entry.entry_id = source.entry_id
ON CONFLICT (season_id, source_result_id) DO NOTHING;

INSERT INTO competition.tournaments (
  tournament_id,
  season_id,
  name,
  creator,
  admin_entry_id,
  league_id,
  league_type,
  total_team_num,
  tournament_mode,
  group_mode,
  group_team_num,
  group_num,
  group_started_event_id,
  group_ended_event_id,
  group_auto_averages,
  group_rounds,
  group_play_against_num,
  group_qualify_num,
  knockout_mode,
  knockout_team_num,
  knockout_rounds,
  knockout_event_num,
  knockout_started_event_id,
  knockout_ended_event_id,
  knockout_play_against_num,
  state,
  setup_status,
  setup_error,
  setup_started_at,
  setup_finished_at,
  source_league_name,
  roster_mode,
  roster_sync_status,
  roster_last_synced_at,
  roster_sync_error,
  setup_phase,
  setup_completed_units,
  setup_total_units,
  setup_progress_updated_at,
  standings_ready_at,
  setup_warning_count,
  created_at,
  updated_at
)
SELECT
  source.id,
  season.season_id,
  source.name,
  source.creator,
  source.admin_entry_id,
  source.league_id,
  source.league_type::text::competition.league_type,
  source.total_team_num,
  source.tournament_mode::text::competition.tournament_mode,
  source.group_mode::text::competition.group_mode,
  source.group_team_num,
  source.group_num,
  source.group_started_event_id,
  source.group_ended_event_id,
  source.group_auto_averages,
  source.group_rounds,
  source.group_play_against_num,
  source.group_qualify_num,
  source.knockout_mode::text::competition.knockout_mode,
  source.knockout_team_num,
  source.knockout_rounds,
  source.knockout_event_num,
  source.knockout_started_event_id,
  source.knockout_ended_event_id,
  source.knockout_play_against_num,
  source.state::text::competition.tournament_state,
  source.setup_status::text::competition.tournament_setup_status,
  source.setup_error,
  source.setup_started_at,
  source.setup_finished_at,
  source.source_league_name,
  source.roster_mode::text::competition.tournament_roster_mode,
  source.roster_sync_status::text::competition.tournament_setup_status,
  source.roster_last_synced_at,
  source.roster_sync_error,
  source.setup_phase::text::competition.tournament_setup_phase,
  source.setup_completed_units,
  source.setup_total_units,
  source.setup_progress_updated_at,
  source.standings_ready_at,
  source.setup_warning_count,
  source.created_at,
  source.updated_at
FROM public.tournament_infos source
JOIN fpl.seasons season ON season.season_code = '2627'
ON CONFLICT (tournament_id) DO NOTHING;

INSERT INTO competition.tournament_entries (
  tournament_id,
  season_id,
  league_id,
  entry_id,
  created_at
)
SELECT
  source.tournament_id,
  tournament.season_id,
  source.league_id,
  source.entry_id,
  source.created_at
FROM public.tournament_entries source
JOIN competition.tournaments tournament ON tournament.tournament_id = source.tournament_id
ON CONFLICT (tournament_id, entry_id) DO NOTHING;

INSERT INTO competition.tournament_groups (
  source_group_row_id,
  tournament_id,
  season_id,
  group_id,
  group_name,
  group_index,
  entry_id,
  started_event_id,
  ended_event_id,
  group_points,
  group_rank,
  played,
  won,
  drawn,
  lost,
  total_points,
  total_transfers_cost,
  total_net_points,
  qualified,
  overall_rank,
  created_at,
  updated_at
)
SELECT
  source.id,
  source.tournament_id,
  tournament.season_id,
  source.group_id,
  source.group_name,
  source.group_index,
  source.entry_id,
  source.started_event_id,
  source.ended_event_id,
  source.group_points,
  source.group_rank,
  source.played,
  source.won,
  source.drawn,
  source.lost,
  source.total_points,
  source.total_transfers_cost,
  source.total_net_points,
  source.qualified,
  source.overall_rank,
  source.created_at,
  source.updated_at
FROM public.tournament_groups source
JOIN competition.tournaments tournament ON tournament.tournament_id = source.tournament_id
ON CONFLICT (tournament_id, group_id, entry_id) DO NOTHING;

INSERT INTO competition.tournament_knockouts (
  source_knockout_id,
  tournament_id,
  season_id,
  round,
  started_event_id,
  ended_event_id,
  match_id,
  next_match_id,
  home_entry_id,
  home_net_points,
  home_goals_scored,
  home_goals_conceded,
  home_wins,
  away_entry_id,
  away_net_points,
  away_goals_scored,
  away_goals_conceded,
  away_wins,
  round_winner,
  created_at,
  updated_at
)
SELECT
  source.id,
  source.tournament_id,
  tournament.season_id,
  source.round,
  source.started_event_id,
  source.ended_event_id,
  source.match_id,
  source.next_match_id,
  source.home_entry_id,
  source.home_net_points,
  source.home_goals_scored,
  source.home_goals_conceded,
  source.home_wins,
  source.away_entry_id,
  source.away_net_points,
  source.away_goals_scored,
  source.away_goals_conceded,
  source.away_wins,
  source.round_winner,
  source.created_at,
  source.updated_at
FROM public.tournament_knockouts source
JOIN competition.tournaments tournament ON tournament.tournament_id = source.tournament_id
ON CONFLICT (tournament_id, match_id) DO NOTHING;

INSERT INTO competition.tournament_battle_group_results (
  source_result_id,
  tournament_id,
  season_id,
  group_id,
  event_id,
  home_index,
  home_entry_id,
  home_net_points,
  home_rank,
  home_match_points,
  away_index,
  away_entry_id,
  away_net_points,
  away_rank,
  away_match_points,
  created_at,
  updated_at
)
SELECT
  source.id,
  source.tournament_id,
  tournament.season_id,
  source.group_id,
  source.event_id,
  source.home_index,
  source.home_entry_id,
  source.home_net_points,
  source.home_rank,
  source.home_match_points,
  source.away_index,
  source.away_entry_id,
  source.away_net_points,
  source.away_rank,
  source.away_match_points,
  source.created_at,
  source.updated_at
FROM public.tournament_battle_group_results source
JOIN competition.tournaments tournament ON tournament.tournament_id = source.tournament_id
ON CONFLICT (tournament_id, source_result_id) DO NOTHING;

INSERT INTO competition.tournament_points_group_results (
  source_result_id,
  tournament_id,
  season_id,
  group_id,
  event_id,
  entry_id,
  event_group_rank,
  event_points,
  event_cost,
  event_net_points,
  event_rank,
  cumulative_transfers,
  cumulative_costs,
  cumulative_bench_points,
  cumulative_auto_sub_points,
  created_at,
  updated_at
)
SELECT
  source.id,
  source.tournament_id,
  tournament.season_id,
  source.group_id,
  source.event_id,
  source.entry_id,
  source.event_group_rank,
  source.event_points,
  source.event_cost,
  source.event_net_points,
  source.event_rank,
  source.cum_transfers_num,
  source.cum_total_costs,
  source.cum_total_bench_points,
  source.cum_auto_sub_points,
  source.created_at,
  source.updated_at
FROM public.tournament_points_group_results source
JOIN competition.tournaments tournament ON tournament.tournament_id = source.tournament_id
ON CONFLICT (tournament_id, source_result_id) DO NOTHING;

INSERT INTO competition.tournament_knockout_results (
  source_result_id,
  tournament_id,
  season_id,
  event_id,
  match_id,
  play_against_id,
  home_entry_id,
  home_net_points,
  home_goals_scored,
  home_goals_conceded,
  away_entry_id,
  away_net_points,
  away_goals_scored,
  away_goals_conceded,
  match_winner,
  created_at,
  updated_at
)
SELECT
  source.id,
  source.tournament_id,
  tournament.season_id,
  source.event_id,
  source.match_id,
  source.play_against_id,
  source.home_entry_id,
  source.home_net_points,
  source.home_goals_scored,
  source.home_goals_conceded,
  source.away_entry_id,
  source.away_net_points,
  source.away_goals_scored,
  source.away_goals_conceded,
  source.match_winner,
  source.created_at,
  source.updated_at
FROM public.tournament_knockout_results source
JOIN competition.tournaments tournament ON tournament.tournament_id = source.tournament_id
ON CONFLICT (tournament_id, source_result_id) DO NOTHING;

DO $competition_sequence_reconciliation$
DECLARE
  target_table text;
  target_column text;
  sequence_name text;
  maximum_id bigint;
BEGIN
  FOR target_table, target_column IN
    VALUES
      ('competition.entry_event_transfers', 'transfer_id'),
      ('competition.league_event_results', 'source_result_id'),
      ('competition.tournaments', 'tournament_id'),
      ('competition.tournament_groups', 'source_group_row_id'),
      ('competition.tournament_knockouts', 'source_knockout_id'),
      ('competition.tournament_battle_group_results', 'source_result_id'),
      ('competition.tournament_points_group_results', 'source_result_id'),
      ('competition.tournament_knockout_results', 'source_result_id')
  LOOP
    sequence_name := pg_get_serial_sequence(target_table, target_column);
    EXECUTE format('SELECT max(%I) FROM %s', target_column, target_table) INTO maximum_id;
    IF maximum_id IS NOT NULL THEN
      PERFORM setval(sequence_name, maximum_id, true);
    END IF;
  END LOOP;
END
$competition_sequence_reconciliation$;

DO $competition_count_reconciliation$
DECLARE
  source_count bigint;
  target_count bigint;
BEGIN
  SELECT count(*) INTO source_count FROM public.entry_infos;
  SELECT count(*) INTO target_count FROM competition.entries;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.entries count mismatch: source %, target %', source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.entry_history_infos;
  SELECT count(*) INTO target_count FROM competition.entry_season_histories;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.entry_season_histories count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.entry_league_infos;
  SELECT count(*) INTO target_count FROM competition.entry_leagues;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.entry_leagues count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  WITH source_pick_sets AS (
    SELECT DISTINCT ON (source.season_id, source.entry_id, source.event_id)
      source.season_id,
      source.entry_id,
      source.event_id,
      source.picks
    FROM (
      SELECT
        entry.season_id,
        source.entry_id,
        source.event_id,
        source.picks,
        1 AS source_priority
      FROM public.entry_event_picks source
      JOIN competition.entries entry ON entry.entry_id = source.entry_id
      WHERE jsonb_typeof(source.picks) = 'array'

      UNION ALL

      SELECT
        entry.season_id,
        source.entry_id,
        source.event_id,
        source.event_picks,
        2
      FROM public.entry_event_results source
      JOIN competition.entries entry ON entry.entry_id = source.entry_id
      WHERE jsonb_typeof(source.event_picks) = 'array'
    ) source
    ORDER BY source.season_id, source.entry_id, source.event_id, source.source_priority
  )
  SELECT count(*) INTO source_count
  FROM source_pick_sets source
  CROSS JOIN LATERAL jsonb_array_elements(source.picks) pick;
  SELECT count(*) INTO target_count FROM competition.entry_event_picks;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.entry_event_picks count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.entry_event_results;
  SELECT count(*) INTO target_count FROM competition.entry_event_results;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.entry_event_results count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.entry_event_transfers;
  SELECT count(*) INTO target_count FROM competition.entry_event_transfers;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.entry_event_transfers count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.entry_event_cup_results;
  SELECT count(*) INTO target_count FROM competition.entry_event_cup_results;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.entry_event_cup_results count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.league_event_results;
  SELECT count(*) INTO target_count FROM competition.league_event_results;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.league_event_results count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.tournament_infos;
  SELECT count(*) INTO target_count FROM competition.tournaments;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.tournaments count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.tournament_entries;
  SELECT count(*) INTO target_count FROM competition.tournament_entries;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.tournament_entries count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.tournament_groups;
  SELECT count(*) INTO target_count FROM competition.tournament_groups;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.tournament_groups count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.tournament_knockouts;
  SELECT count(*) INTO target_count FROM competition.tournament_knockouts;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.tournament_knockouts count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.tournament_battle_group_results;
  SELECT count(*) INTO target_count FROM competition.tournament_battle_group_results;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.tournament_battle_group_results count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.tournament_points_group_results;
  SELECT count(*) INTO target_count FROM competition.tournament_points_group_results;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.tournament_points_group_results count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.tournament_knockout_results;
  SELECT count(*) INTO target_count FROM competition.tournament_knockout_results;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'competition.tournament_knockout_results count mismatch: source %, target %',
      source_count, target_count;
  END IF;
END
$competition_count_reconciliation$;

CREATE TEMPORARY TABLE v3_competition_reconciliation_specs (
  check_name text PRIMARY KEY,
  source_object text NOT NULL,
  target_object text NOT NULL,
  source_query text NOT NULL,
  target_query text NOT NULL
) ON COMMIT DROP;

INSERT INTO v3_competition_reconciliation_specs (
  check_name,
  source_object,
  target_object,
  source_query,
  target_query
)
VALUES
  (
    '0086_competition_entries_keyset',
    'public.entry_infos',
    'competition.entries',
    $source$SELECT concat_ws(':', season.season_id, source.id)::text AS canonical_row
      FROM public.entry_infos source
      JOIN fpl.seasons season
        ON season.season_code = COALESCE(
          NULLIF(source.entry_snapshot_synced_season, ''),
          NULLIF(source.entry_transfers_synced_season, ''),
          '2627'
        )$source$,
    $target$SELECT concat_ws(':', season_id, entry_id)::text AS canonical_row
      FROM competition.entries$target$
  ),
  (
    '0086_competition_entry_season_histories_keyset',
    'public.entry_history_infos',
    'competition.entry_season_histories',
    $source$SELECT concat_ws(':', season.season_id, source.entry_id)::text AS canonical_row
      FROM public.entry_history_infos source
      JOIN fpl.seasons season ON season.display_name = btrim(source.season)$source$,
    $target$SELECT concat_ws(':', season_id, entry_id)::text AS canonical_row
      FROM competition.entry_season_histories$target$
  ),
  (
    '0086_competition_entry_leagues_keyset',
    'public.entry_league_infos',
    'competition.entry_leagues',
    $source$SELECT concat_ws(
        ':', entry.season_id, source.entry_id, source.league_id, source.league_type::text
      )::text AS canonical_row
      FROM public.entry_league_infos source
      JOIN competition.entries entry ON entry.entry_id = source.entry_id$source$,
    $target$SELECT concat_ws(
        ':', season_id, entry_id, league_id, league_type::text
      )::text AS canonical_row
      FROM competition.entry_leagues$target$
  ),
  (
    '0086_competition_entry_event_picks_keyset',
    'public.entry_event_picks + public.entry_event_results fallback',
    'competition.entry_event_picks',
    $source$WITH source_pick_sets AS (
        SELECT DISTINCT ON (source.season_id, source.entry_id, source.event_id)
          source.season_id,
          source.entry_id,
          source.event_id,
          source.picks
        FROM (
          SELECT
            entry.season_id,
            source.entry_id,
            source.event_id,
            source.picks,
            1 AS source_priority
          FROM public.entry_event_picks source
          JOIN competition.entries entry ON entry.entry_id = source.entry_id
          WHERE jsonb_typeof(source.picks) = 'array'
          UNION ALL
          SELECT
            entry.season_id,
            source.entry_id,
            source.event_id,
            source.event_picks,
            2
          FROM public.entry_event_results source
          JOIN competition.entries entry ON entry.entry_id = source.entry_id
          WHERE jsonb_typeof(source.event_picks) = 'array'
        ) source
        ORDER BY source.season_id, source.entry_id, source.event_id, source.source_priority
      )
      SELECT concat_ws(
        ':', source.season_id, source.entry_id, source.event_id, pick.item ->> 'position'
      )::text AS canonical_row
      FROM source_pick_sets source
      CROSS JOIN LATERAL jsonb_array_elements(source.picks) pick(item)$source$,
    $target$SELECT concat_ws(':', season_id, entry_id, event_id, position)::text AS canonical_row
      FROM competition.entry_event_picks$target$
  ),
  (
    '0086_competition_entry_event_results_keyset',
    'public.entry_event_results',
    'competition.entry_event_results',
    $source$SELECT concat_ws(
        ':', entry.season_id, source.entry_id, source.event_id
      )::text AS canonical_row
      FROM public.entry_event_results source
      JOIN competition.entries entry ON entry.entry_id = source.entry_id$source$,
    $target$SELECT concat_ws(':', season_id, entry_id, event_id)::text AS canonical_row
      FROM competition.entry_event_results$target$
  ),
  (
    '0086_competition_entry_event_transfers_keyset',
    'public.entry_event_transfers',
    'competition.entry_event_transfers',
    $source$SELECT concat_ws(':', entry.season_id, source.id)::text AS canonical_row
      FROM public.entry_event_transfers source
      JOIN competition.entries entry ON entry.entry_id = source.entry_id$source$,
    $target$SELECT concat_ws(':', season_id, transfer_id)::text AS canonical_row
      FROM competition.entry_event_transfers$target$
  ),
  (
    '0086_competition_entry_event_cup_results_keyset',
    'public.entry_event_cup_results',
    'competition.entry_event_cup_results',
    $source$SELECT concat_ws(':', season.season_id, source.id)::text AS canonical_row
      FROM public.entry_event_cup_results source
      JOIN fpl.seasons season
        ON season.season_code = COALESCE(NULLIF(source.source_season, ''), '2627')$source$,
    $target$SELECT concat_ws(':', season_id, source_result_id)::text AS canonical_row
      FROM competition.entry_event_cup_results$target$
  ),
  (
    '0086_competition_league_event_results_keyset',
    'public.league_event_results',
    'competition.league_event_results',
    $source$SELECT concat_ws(':', entry.season_id, source.id)::text AS canonical_row
      FROM public.league_event_results source
      JOIN competition.entries entry ON entry.entry_id = source.entry_id$source$,
    $target$SELECT concat_ws(':', season_id, source_result_id)::text AS canonical_row
      FROM competition.league_event_results$target$
  ),
  (
    '0086_competition_tournaments_keyset',
    'public.tournament_infos',
    'competition.tournaments',
    $source$SELECT id::text AS canonical_row FROM public.tournament_infos$source$,
    $target$SELECT tournament_id::text AS canonical_row FROM competition.tournaments$target$
  ),
  (
    '0086_competition_tournament_entries_keyset',
    'public.tournament_entries',
    'competition.tournament_entries',
    $source$SELECT concat_ws(':', tournament_id, entry_id)::text AS canonical_row
      FROM public.tournament_entries$source$,
    $target$SELECT concat_ws(':', tournament_id, entry_id)::text AS canonical_row
      FROM competition.tournament_entries$target$
  ),
  (
    '0086_competition_tournament_groups_keyset',
    'public.tournament_groups',
    'competition.tournament_groups',
    $source$SELECT id::text AS canonical_row FROM public.tournament_groups$source$,
    $target$SELECT source_group_row_id::text AS canonical_row
      FROM competition.tournament_groups$target$
  ),
  (
    '0086_competition_tournament_knockouts_keyset',
    'public.tournament_knockouts',
    'competition.tournament_knockouts',
    $source$SELECT id::text AS canonical_row FROM public.tournament_knockouts$source$,
    $target$SELECT source_knockout_id::text AS canonical_row
      FROM competition.tournament_knockouts$target$
  ),
  (
    '0086_competition_tournament_battle_results_keyset',
    'public.tournament_battle_group_results',
    'competition.tournament_battle_group_results',
    $source$SELECT id::text AS canonical_row
      FROM public.tournament_battle_group_results$source$,
    $target$SELECT source_result_id::text AS canonical_row
      FROM competition.tournament_battle_group_results$target$
  ),
  (
    '0086_competition_tournament_points_results_keyset',
    'public.tournament_points_group_results',
    'competition.tournament_points_group_results',
    $source$SELECT id::text AS canonical_row
      FROM public.tournament_points_group_results$source$,
    $target$SELECT source_result_id::text AS canonical_row
      FROM competition.tournament_points_group_results$target$
  ),
  (
    '0086_competition_tournament_knockout_results_keyset',
    'public.tournament_knockout_results',
    'competition.tournament_knockout_results',
    $source$SELECT id::text AS canonical_row
      FROM public.tournament_knockout_results$source$,
    $target$SELECT source_result_id::text AS canonical_row
      FROM competition.tournament_knockout_results$target$
  );

DO $record_competition_reconciliation_evidence$
DECLARE
  spec record;
  source_count bigint;
  source_hash text;
  target_count bigint;
  target_hash text;
BEGIN
  FOR spec IN SELECT * FROM v3_competition_reconciliation_specs ORDER BY check_name
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
      RAISE EXCEPTION 'competition reconciliation failed for %: source %/%, target %/%',
        spec.check_name,
        source_count,
        source_hash,
        target_count,
        target_hash;
    END IF;
  END LOOP;
END
$record_competition_reconciliation_evidence$;

ANALYZE competition.entries;
ANALYZE competition.entry_season_histories;
ANALYZE competition.entry_leagues;
ANALYZE competition.entry_event_picks;
ANALYZE competition.entry_event_results;
ANALYZE competition.entry_event_transfers;
ANALYZE competition.entry_event_cup_results;
ANALYZE competition.league_event_results;
ANALYZE competition.tournaments;
ANALYZE competition.tournament_entries;
ANALYZE competition.tournament_groups;
ANALYZE competition.tournament_knockouts;
ANALYZE competition.tournament_battle_group_results;
ANALYZE competition.tournament_points_group_results;
ANALYZE competition.tournament_knockout_results;

RESET ROLE;
