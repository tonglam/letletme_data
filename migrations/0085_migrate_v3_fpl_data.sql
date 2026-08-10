-- Deterministic multi-season FPL conversion from current tables plus history parents.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
SET LOCAL ROLE letletme_data_owner;

-- A failed 0085 transaction leaves no visible target rows, but PostgreSQL may
-- retain the rolled-back heap/index pages until vacuum. Refuse any live target
-- data, then reset the large staging facts so an immediate retry has the same
-- cost profile as the first run and cannot merge with a partial/manual load.
DO $empty_fpl_target_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM fpl.teams)
     OR EXISTS (SELECT 1 FROM fpl.players)
     OR EXISTS (SELECT 1 FROM fpl.phases)
     OR EXISTS (SELECT 1 FROM fpl.events)
     OR EXISTS (SELECT 1 FROM fpl.fixtures)
     OR EXISTS (SELECT 1 FROM fpl.player_event_snapshots)
     OR EXISTS (SELECT 1 FROM fpl.player_gameweek_stats)
     OR EXISTS (SELECT 1 FROM fpl.player_gameweek_scoring_items)
     OR EXISTS (SELECT 1 FROM fpl.player_fixture_stats)
     OR EXISTS (SELECT 1 FROM fpl.player_market_snapshots) THEN
    RAISE EXCEPTION '0085 requires empty FPL targets; refusing a partial/manual merge';
  END IF;
END
$empty_fpl_target_preflight$;

TRUNCATE TABLE
  fpl.player_gameweek_scoring_items,
  fpl.player_gameweek_stats,
  fpl.player_fixture_stats,
  fpl.player_event_snapshots,
  fpl.player_market_snapshots;

INSERT INTO fpl.teams (
  season_id,
  team_id,
  code,
  name,
  short_name,
  strength,
  position,
  points,
  win,
  draw,
  loss,
  played,
  form,
  team_division,
  unavailable,
  strength_overall_home,
  strength_overall_away,
  strength_attack_home,
  strength_attack_away,
  strength_defence_home,
  strength_defence_away,
  pulse_id,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.team_id,
  source.code,
  source.name,
  source.short_name,
  source.strength,
  source.position,
  source.points,
  source.win,
  source.draw,
  source.loss,
  source.played,
  source.form,
  source.team_division,
  source.unavailable,
  source.strength_overall_home,
  source.strength_overall_away,
  source.strength_attack_home,
  source.strength_attack_away,
  source.strength_defence_home,
  source.strength_defence_away,
  source.pulse_id,
  source.created_at,
  source.updated_at
FROM (
  SELECT
    history.season AS season_code,
    history.id AS team_id,
    history.code,
    history.name,
    history.short_name,
    history.strength,
    history.position,
    history.points,
    history.win,
    history.draw,
    history.loss,
    history.played,
    history.form,
    history.team_division,
    history.unavailable,
    history.strength_overall_home,
    history.strength_overall_away,
    history.strength_attack_home,
    history.strength_attack_away,
    history.strength_defence_home,
    history.strength_defence_away,
    history.pulse_id,
    history.created_at,
    history.updated_at
  FROM public.teams_history history
  WHERE history.season <> '2627'

  UNION ALL

  SELECT
    '2627',
    current.id,
    current.code,
    current.name,
    current.short_name,
    current.strength,
    current.position,
    current.points,
    current.win,
    current.draw,
    current.loss,
    current.played,
    current.form,
    current.team_division,
    current.unavailable,
    current.strength_overall_home,
    current.strength_overall_away,
    current.strength_attack_home,
    current.strength_attack_away,
    current.strength_defence_home,
    current.strength_defence_away,
    current.pulse_id,
    current.created_at,
    current.updated_at
  FROM public.teams current
) source
JOIN fpl.seasons season ON season.season_code = source.season_code
ON CONFLICT (season_id, team_id) DO NOTHING;

INSERT INTO fpl.players (
  season_id,
  element_id,
  code,
  element_type,
  team_id,
  price,
  start_price,
  first_name,
  second_name,
  web_name,
  total_points,
  price_source_checked_at,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.element_id,
  source.code,
  source.element_type,
  source.team_id,
  source.price,
  source.start_price,
  source.first_name,
  source.second_name,
  source.web_name,
  COALESCE(source.total_points, 0),
  source.price_source_checked_at,
  source.created_at,
  source.updated_at
FROM (
  SELECT
    history.season AS season_code,
    history.id AS element_id,
    history.code,
    history.type AS element_type,
    history.team_id,
    history.price,
    history.start_price,
    history.first_name,
    history.second_name,
    history.web_name,
    history.total_points,
    history.price_source_checked_at,
    history.created_at,
    history.updated_at
  FROM public.players_history history
  WHERE history.season <> '2627'

  UNION ALL

  SELECT
    '2627',
    current.id,
    current.code,
    current.type,
    current.team_id,
    current.price,
    current.start_price,
    current.first_name,
    current.second_name,
    current.web_name,
    current.total_points,
    current.price_source_checked_at,
    current.created_at,
    current.updated_at
  FROM public.players current
) source
JOIN fpl.seasons season ON season.season_code = source.season_code
ON CONFLICT (season_id, element_id) DO NOTHING;

INSERT INTO fpl.events (
  season_id,
  event_id,
  name,
  deadline_time,
  average_entry_score,
  finished,
  data_checked,
  highest_scoring_entry,
  deadline_time_epoch,
  deadline_time_game_offset,
  highest_score,
  is_previous,
  is_current,
  is_next,
  cup_league_create,
  h2h_ko_matches_created,
  chip_plays,
  most_selected,
  most_transferred_in,
  top_element,
  top_element_info,
  transfers_made,
  most_captained,
  most_vice_captained,
  live_snapshot_checked_at,
  live_snapshot_finalized_at,
  data_checked_at,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.event_id,
  source.name,
  source.deadline_time,
  source.average_entry_score,
  source.finished,
  source.data_checked,
  source.highest_scoring_entry,
  source.deadline_time_epoch,
  source.deadline_time_game_offset,
  source.highest_score,
  source.is_previous,
  source.is_current,
  source.is_next,
  source.cup_league_create,
  source.h2h_ko_matches_created,
  CASE jsonb_typeof(source.chip_plays)
    WHEN 'array' THEN source.chip_plays
    WHEN 'string' THEN COALESCE((source.chip_plays #>> '{}')::jsonb, '[]'::jsonb)
    ELSE '[]'::jsonb
  END,
  source.most_selected,
  source.most_transferred_in,
  source.top_element,
  source.top_element_info,
  source.transfers_made,
  source.most_captained,
  source.most_vice_captained,
  source.live_snapshot_checked_at,
  source.live_snapshot_finalized_at,
  source.data_checked_at,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM (
  SELECT
    history.season AS season_code,
    history.id AS event_id,
    history.name,
    history.deadline_time,
    history.average_entry_score,
    history.finished,
    history.data_checked,
    history.highest_scoring_entry,
    history.deadline_time_epoch,
    history.deadline_time_game_offset,
    history.highest_score,
    history.is_previous,
    history.is_current,
    history.is_next,
    history.cup_league_create,
    history.h2h_ko_matches_created,
    history.chip_plays,
    history.most_selected,
    history.most_transferred_in,
    history.top_element,
    history.top_element_info,
    history.transfers_made,
    history.most_captained,
    history.most_vice_captained,
    history.live_snapshot_checked_at,
    history.live_snapshot_finalized_at,
    NULL::timestamptz AS data_checked_at,
    history.created_at,
    history.updated_at
  FROM public.events_history history
  WHERE history.season <> '2627'

  UNION ALL

  SELECT
    '2627',
    current.id,
    current.name,
    current.deadline_time,
    current.average_entry_score,
    current.finished,
    current.data_checked,
    current.highest_scoring_entry,
    current.deadline_time_epoch,
    current.deadline_time_game_offset,
    current.highest_score,
    current.is_previous,
    current.is_current,
    current.is_next,
    current.cup_league_create,
    current.h2h_ko_matches_created,
    current.chip_plays,
    current.most_selected,
    current.most_transferred_in,
    current.top_element,
    current.top_element_info,
    current.transfers_made,
    current.most_captained,
    current.most_vice_captained,
    current.live_snapshot_checked_at,
    current.live_snapshot_finalized_at,
    current.data_checked_at,
    current.created_at,
    current.updated_at
  FROM public.events current
) source
JOIN fpl.seasons season ON season.season_code = source.season_code
ON CONFLICT (season_id, event_id) DO NOTHING;

INSERT INTO fpl.phases (
  season_id,
  phase_id,
  name,
  start_event,
  stop_event,
  highest_score,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.phase_id,
  source.name,
  source.start_event,
  source.stop_event,
  source.highest_score,
  source.created_at,
  source.updated_at
FROM (
  SELECT
    history.season AS season_code,
    history.id AS phase_id,
    history.name,
    history.start_event,
    history.stop_event,
    history.highest_score,
    history.created_at,
    history.updated_at
  FROM public.phases_history history
  WHERE history.season <> '2627'

  UNION ALL

  SELECT
    '2627',
    current.id,
    current.name,
    current.start_event,
    current.stop_event,
    current.highest_score,
    current.created_at,
    current.updated_at
  FROM public.phases current
) source
JOIN fpl.seasons season ON season.season_code = source.season_code
ON CONFLICT (season_id, phase_id) DO NOTHING;

INSERT INTO fpl.fixtures (
  season_id,
  fixture_id,
  code,
  event_id,
  kickoff_time,
  started,
  finished,
  finished_provisional,
  provisional_start_time,
  minutes,
  team_h_id,
  team_h_difficulty,
  team_h_score,
  team_a_id,
  team_a_difficulty,
  team_a_score,
  stats,
  pulse_id,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.fixture_id,
  source.code,
  NULLIF(source.event_id, 0),
  source.kickoff_time,
  source.started,
  source.finished,
  source.finished_provisional,
  source.provisional_start_time,
  source.minutes,
  source.team_h_id,
  source.team_h_difficulty,
  source.team_h_score,
  source.team_a_id,
  source.team_a_difficulty,
  source.team_a_score,
  CASE jsonb_typeof(source.stats)
    WHEN 'array' THEN source.stats
    WHEN 'string' THEN COALESCE((source.stats #>> '{}')::jsonb, '[]'::jsonb)
    ELSE '[]'::jsonb
  END,
  source.pulse_id,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM (
  SELECT
    history.season AS season_code,
    history.id AS fixture_id,
    history.code,
    history.event_id,
    history.kickoff_time,
    history.started,
    history.finished,
    history.finished_provisional,
    history.provisional_start_time,
    history.minutes,
    history.team_h_id,
    history.team_h_difficulty,
    history.team_h_score,
    history.team_a_id,
    history.team_a_difficulty,
    history.team_a_score,
    history.stats,
    history.pulse_id,
    history.created_at,
    history.updated_at
  FROM public.event_fixtures_history history
  WHERE history.season <> '2627'

  UNION ALL

  SELECT
    '2627',
    current.id,
    current.code,
    current.event_id,
    current.kickoff_time,
    current.started,
    current.finished,
    current.finished_provisional,
    current.provisional_start_time,
    current.minutes,
    current.team_h_id,
    current.team_h_difficulty,
    current.team_h_score,
    current.team_a_id,
    current.team_a_difficulty,
    current.team_a_score,
    current.stats,
    current.pulse_id,
    current.created_at,
    current.updated_at
  FROM public.event_fixtures current
) source
JOIN fpl.seasons season ON season.season_code = source.season_code
ON CONFLICT (season_id, fixture_id) DO NOTHING;

INSERT INTO fpl.player_event_snapshots (
  season_id,
  event_id,
  element_id,
  source_snapshot_id,
  element_type,
  total_points,
  form,
  influence,
  creativity,
  threat,
  ict_index,
  expected_goals,
  expected_assists,
  expected_goal_involvements,
  expected_goals_conceded,
  minutes,
  goals_scored,
  assists,
  clean_sheets,
  goals_conceded,
  own_goals,
  penalties_saved,
  yellow_cards,
  red_cards,
  saves,
  bonus,
  bps,
  starts,
  influence_rank,
  influence_rank_type,
  creativity_rank,
  creativity_rank_type,
  threat_rank,
  threat_rank_type,
  ict_index_rank,
  ict_index_rank_type,
  transfers_in,
  transfers_in_event,
  transfers_out,
  transfers_out_event,
  selected_by_percent,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.event_id,
  source.element_id,
  source.source_snapshot_id,
  source.element_type,
  source.total_points,
  source.form::numeric,
  source.influence::numeric,
  source.creativity::numeric,
  source.threat::numeric,
  source.ict_index::numeric,
  source.expected_goals,
  source.expected_assists,
  source.expected_goal_involvements,
  source.expected_goals_conceded,
  source.minutes,
  source.goals_scored,
  source.assists,
  source.clean_sheets,
  source.goals_conceded,
  source.own_goals,
  source.penalties_saved,
  source.yellow_cards,
  source.red_cards,
  source.saves,
  source.bonus,
  source.bps,
  source.starts,
  source.influence_rank,
  source.influence_rank_type,
  source.creativity_rank,
  source.creativity_rank_type,
  source.threat_rank,
  source.threat_rank_type,
  source.ict_index_rank,
  source.ict_index_rank_type,
  source.transfers_in,
  source.transfers_in_event,
  source.transfers_out,
  source.transfers_out_event,
  NULLIF(source.selected_by_percent, '')::numeric,
  source.created_at,
  source.updated_at
FROM (
  SELECT
    history.season AS season_code,
    history.event_id,
    history.element_id,
    history.id AS source_snapshot_id,
    history.element_type,
    history.total_points,
    history.form,
    history.influence,
    history.creativity,
    history.threat,
    history.ict_index,
    history.expected_goals,
    history.expected_assists,
    history.expected_goal_involvements,
    history.expected_goals_conceded,
    history.minutes,
    history.goals_scored,
    history.assists,
    history.clean_sheets,
    history.goals_conceded,
    history.own_goals,
    history.penalties_saved,
    history.yellow_cards,
    history.red_cards,
    history.saves,
    history.bonus,
    history.bps,
    history.starts,
    history.influence_rank,
    history.influence_rank_type,
    history.creativity_rank,
    history.creativity_rank_type,
    history.threat_rank,
    history.threat_rank_type,
    history.ict_index_rank,
    history.ict_index_rank_type,
    history.transfers_in,
    history.transfers_in_event,
    history.transfers_out,
    history.transfers_out_event,
    history.selected_by_percent,
    history.created_at,
    history.updated_at
  FROM public.player_stats_history history
  WHERE history.season <> '2627'

  UNION ALL

  SELECT
    '2627',
    current.event_id,
    current.element_id,
    current.id,
    current.element_type,
    current.total_points,
    current.form,
    current.influence,
    current.creativity,
    current.threat,
    current.ict_index,
    current.expected_goals,
    current.expected_assists,
    current.expected_goal_involvements,
    current.expected_goals_conceded,
    current.minutes,
    current.goals_scored,
    current.assists,
    current.clean_sheets,
    current.goals_conceded,
    current.own_goals,
    current.penalties_saved,
    current.yellow_cards,
    current.red_cards,
    current.saves,
    current.bonus,
    current.bps,
    current.starts,
    current.influence_rank,
    current.influence_rank_type,
    current.creativity_rank,
    current.creativity_rank_type,
    current.threat_rank,
    current.threat_rank_type,
    current.ict_index_rank,
    current.ict_index_rank_type,
    current.transfers_in,
    current.transfers_in_event,
    current.transfers_out,
    current.transfers_out_event,
    current.selected_by_percent,
    current.created_at,
    current.updated_at
  FROM public.player_stats current
) source
JOIN fpl.seasons season ON season.season_code = source.season_code
ON CONFLICT (season_id, event_id, element_id) DO NOTHING;

INSERT INTO fpl.player_gameweek_stats (
  season_id,
  event_id,
  element_id,
  source_live_id,
  minutes,
  goals_scored,
  assists,
  clean_sheets,
  goals_conceded,
  own_goals,
  penalties_saved,
  penalties_missed,
  yellow_cards,
  red_cards,
  saves,
  bonus,
  bps,
  starts,
  expected_goals,
  expected_assists,
  expected_goal_involvements,
  expected_goals_conceded,
  in_dream_team,
  total_points,
  defensive_contribution,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.event_id,
  source.element_id,
  source.source_live_id,
  source.minutes,
  source.goals_scored,
  source.assists,
  source.clean_sheets,
  source.goals_conceded,
  source.own_goals,
  source.penalties_saved,
  source.penalties_missed,
  source.yellow_cards,
  source.red_cards,
  source.saves,
  source.bonus,
  source.bps,
  source.starts,
  source.expected_goals,
  source.expected_assists,
  source.expected_goal_involvements,
  source.expected_goals_conceded,
  source.in_dream_team,
  source.total_points,
  source.defensive_contribution,
  source.created_at,
  source.updated_at
FROM (
  SELECT
    history.season AS season_code,
    history.event_id,
    history.element_id,
    history.id AS source_live_id,
    history.minutes,
    history.goals_scored,
    history.assists,
    history.clean_sheets,
    history.goals_conceded,
    history.own_goals,
    history.penalties_saved,
    history.penalties_missed,
    history.yellow_cards,
    history.red_cards,
    history.saves,
    history.bonus,
    history.bps,
    history.starts,
    history.expected_goals,
    history.expected_assists,
    history.expected_goal_involvements,
    history.expected_goals_conceded,
    history.in_dream_team,
    history.total_points,
    history.defensive_contribution,
    history.created_at,
    history.updated_at
  FROM public.event_lives_history history
  WHERE history.season <> '2627'

  UNION ALL

  SELECT
    '2627',
    current.event_id,
    current.element_id,
    current.id,
    current.minutes,
    current.goals_scored,
    current.assists,
    current.clean_sheets,
    current.goals_conceded,
    current.own_goals,
    current.penalties_saved,
    current.penalties_missed,
    current.yellow_cards,
    current.red_cards,
    current.saves,
    current.bonus,
    current.bps,
    current.starts,
    current.expected_goals,
    current.expected_assists,
    current.expected_goal_involvements,
    current.expected_goals_conceded,
    current.in_dream_team,
    current.total_points,
    current.defensive_contribution,
    current.created_at,
    current.updated_at
  FROM public.event_lives current
) source
JOIN fpl.seasons season ON season.season_code = source.season_code
ON CONFLICT (season_id, event_id, element_id) DO NOTHING;

WITH source_explains AS (
  SELECT
    history.season AS season_code,
    history.id AS source_explain_id,
    history.event_id,
    history.element_id,
    history.bonus,
    history.minutes,
    history.minutes_points,
    history.goals_scored,
    history.goals_scored_points,
    history.assists,
    history.assists_points,
    history.clean_sheets,
    history.clean_sheets_points,
    history.goals_conceded,
    history.goals_conceded_points,
    history.own_goals,
    history.own_goals_points,
    history.penalties_saved,
    history.penalties_saved_points,
    history.penalties_missed,
    history.penalties_missed_points,
    history.yellow_cards,
    history.yellow_cards_points,
    history.red_cards,
    history.red_cards_points,
    history.saves,
    history.saves_points,
    history.defensive_contribution,
    history.defensive_contribution_points,
    history.created_at,
    COALESCE(history.updated_at, history.created_at) AS updated_at
  FROM public.event_live_explains_history history
  WHERE history.season <> '2627'

  UNION ALL

  SELECT
    '2627',
    current.id,
    current.event_id,
    current.element_id,
    current.bonus,
    current.minutes,
    current.minutes_points,
    current.goals_scored,
    current.goals_scored_points,
    current.assists,
    current.assists_points,
    current.clean_sheets,
    current.clean_sheets_points,
    current.goals_conceded,
    current.goals_conceded_points,
    current.own_goals,
    current.own_goals_points,
    current.penalties_saved,
    current.penalties_saved_points,
    current.penalties_missed,
    current.penalties_missed_points,
    current.yellow_cards,
    current.yellow_cards_points,
    current.red_cards,
    current.red_cards_points,
    current.saves,
    current.saves_points,
    current.defensive_contribution,
    current.defensive_contribution_points,
    current.created_at,
    COALESCE(current.updated_at, current.created_at)
  FROM public.event_live_explains current
), normalized AS (
  SELECT
    source.season_code,
    source.event_id,
    source.element_id,
    metric.scoring_identifier,
    COALESCE(metric.scoring_value, 0) AS scoring_value,
    COALESCE(metric.points, 0) AS points,
    source.source_explain_id,
    source.created_at,
    source.updated_at
  FROM source_explains source
  CROSS JOIN LATERAL (
    VALUES
      ('minutes'::text, source.minutes, source.minutes_points),
      ('goals_scored', source.goals_scored, source.goals_scored_points),
      ('assists', source.assists, source.assists_points),
      ('clean_sheets', source.clean_sheets, source.clean_sheets_points),
      ('goals_conceded', source.goals_conceded, source.goals_conceded_points),
      ('own_goals', source.own_goals, source.own_goals_points),
      ('penalties_saved', source.penalties_saved, source.penalties_saved_points),
      ('penalties_missed', source.penalties_missed, source.penalties_missed_points),
      ('yellow_cards', source.yellow_cards, source.yellow_cards_points),
      ('red_cards', source.red_cards, source.red_cards_points),
      ('saves', source.saves, source.saves_points),
      ('bonus', source.bonus, source.bonus),
      (
        'defensive_contribution',
        source.defensive_contribution,
        source.defensive_contribution_points
      )
  ) AS metric(scoring_identifier, scoring_value, points)
  WHERE COALESCE(metric.scoring_value, 0) <> 0 OR COALESCE(metric.points, 0) <> 0
)
INSERT INTO fpl.player_gameweek_scoring_items (
  season_id,
  event_id,
  element_id,
  scoring_identifier,
  scoring_value,
  points,
  source_explain_id,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  normalized.event_id,
  normalized.element_id,
  normalized.scoring_identifier,
  normalized.scoring_value,
  normalized.points,
  normalized.source_explain_id,
  normalized.created_at,
  normalized.updated_at
FROM normalized
JOIN fpl.seasons season ON season.season_code = normalized.season_code
ON CONFLICT (season_id, event_id, element_id, scoring_identifier) DO NOTHING;

INSERT INTO fpl.player_fixture_stats (
  season_id,
  fixture_id,
  element_id,
  source_fixture_stat_id,
  event_id,
  fixture_code,
  player_code,
  team_id,
  team_code,
  element_type,
  minutes,
  starts,
  goals,
  assists,
  own_goals,
  yellow_cards,
  red_cards,
  source_hash,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.fixture_id,
  source.element_id,
  source.source_fixture_stat_id,
  source.event_id,
  source.fixture_code,
  source.player_code,
  source.team_id,
  source.team_code,
  source.element_type,
  source.minutes,
  source.starts,
  source.goals,
  source.assists,
  source.own_goals,
  source.yellow_cards,
  source.red_cards,
  source.source_hash,
  source.created_at,
  COALESCE(source.updated_at, source.created_at)
FROM (
  SELECT
    history.season AS season_code,
    history.id AS source_fixture_stat_id,
    history.event_id,
    history.fixture_id,
    history.fixture_code,
    history.element_id,
    history.player_code,
    history.team_id,
    history.team_code,
    history.element_type,
    history.minutes,
    history.starts,
    history.goals,
    history.assists,
    history.own_goals,
    history.yellow_cards,
    history.red_cards,
    history.source_hash,
    history.created_at,
    history.updated_at
  FROM public.fpl_player_fixture_stats_history history
  WHERE history.season <> '2627'

  UNION ALL

  SELECT
    current.season,
    current.id,
    current.event_id,
    current.fixture_id,
    current.fixture_code,
    current.element_id,
    current.player_code,
    current.team_id,
    current.team_code,
    current.element_type,
    current.minutes,
    current.starts,
    current.goals,
    current.assists,
    current.own_goals,
    current.yellow_cards,
    current.red_cards,
    current.source_hash,
    current.created_at,
    current.updated_at
  FROM public.fpl_player_fixture_stats current
) source
JOIN fpl.seasons season ON season.season_code = source.season_code
ON CONFLICT (season_id, fixture_id, element_id) DO NOTHING;

INSERT INTO fpl.player_market_snapshots (
  season_id,
  snapshot_date,
  element_id,
  source_snapshot_id,
  snapshot_source,
  source_value_id,
  source_event_id,
  captured_at,
  player_code,
  web_name,
  first_name,
  second_name,
  team_id,
  team_name,
  team_short_name,
  element_type,
  position,
  price,
  selected_by_percent,
  transfers_in,
  transfers_out,
  transfers_in_event,
  transfers_out_event,
  status,
  news,
  news_added,
  chance_of_playing_this_round,
  chance_of_playing_next_round,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  source.snapshot_date,
  source.element_id,
  source.source_snapshot_id,
  'upstream',
  NULL,
  CASE
    WHEN source.season_code = '2627' THEN (
      SELECT source_value.event_id
      FROM public.player_values source_value
      WHERE source_value.element_id = source.element_id
        AND source_value.change_type = 'start'
        AND to_date(btrim(source_value.change_date), 'YYYYMMDD') = source.snapshot_date
      LIMIT 1
    )
    ELSE NULL
  END,
  source.captured_at,
  source.player_code,
  source.web_name,
  source.first_name,
  source.second_name,
  source.team_id,
  source.team_name,
  source.team_short_name,
  source.element_type,
  source.position,
  source.price,
  source.selected_by_percent,
  source.transfers_in,
  source.transfers_out,
  source.transfers_in_event,
  source.transfers_out_event,
  source.status,
  source.news,
  source.news_added,
  source.chance_of_playing_this_round,
  source.chance_of_playing_next_round,
  source.captured_at,
  source.captured_at
FROM (
  SELECT
    history.season AS season_code,
    history.id AS source_snapshot_id,
    history.snapshot_date,
    history.captured_at,
    history.element_id,
    history.player_code,
    history.web_name,
    history.first_name,
    history.second_name,
    history.team_id,
    history.team_name,
    history.team_short_name,
    history.element_type,
    history.position,
    history.price,
    history.selected_by_percent,
    history.transfers_in,
    history.transfers_out,
    history.transfers_in_event,
    history.transfers_out_event,
    history.status,
    history.news,
    history.news_added,
    history.chance_of_playing_this_round,
    history.chance_of_playing_next_round
  FROM public.player_market_snapshots_history history
  WHERE history.season <> '2627'

  UNION ALL

  SELECT
    '2627',
    current.id,
    current.snapshot_date,
    current.captured_at,
    current.element_id,
    current.player_code,
    current.web_name,
    current.first_name,
    current.second_name,
    current.team_id,
    current.team_name,
    current.team_short_name,
    current.element_type,
    current.position,
    current.price,
    current.selected_by_percent,
    current.transfers_in,
    current.transfers_out,
    current.transfers_in_event,
    current.transfers_out_event,
    current.status,
    current.news,
    current.news_added,
    current.chance_of_playing_this_round,
    current.chance_of_playing_next_round
  FROM public.player_market_snapshots current
) source
JOIN fpl.seasons season ON season.season_code = source.season_code
ON CONFLICT (season_id, snapshot_date, element_id) DO NOTHING;

-- Versioned B0 exception: current start values predate the first upstream market capture.
INSERT INTO fpl.player_market_snapshots (
  season_id,
  snapshot_date,
  element_id,
  source_snapshot_id,
  snapshot_source,
  source_value_id,
  source_event_id,
  captured_at,
  player_code,
  web_name,
  first_name,
  second_name,
  team_id,
  team_name,
  team_short_name,
  element_type,
  position,
  price,
  selected_by_percent,
  transfers_in,
  transfers_out,
  transfers_in_event,
  transfers_out_event,
  status,
  news,
  news_added,
  chance_of_playing_this_round,
  chance_of_playing_next_round,
  created_at,
  updated_at
)
SELECT
  season.season_id,
  to_date(btrim(source_value.change_date), 'YYYYMMDD'),
  source_value.element_id,
  NULL,
  'legacy_value_seed',
  source_value.id,
  source_value.event_id,
  source_value.created_at,
  first_market.player_code,
  first_market.web_name,
  first_market.first_name,
  first_market.second_name,
  first_market.team_id,
  first_market.team_name,
  first_market.team_short_name,
  source_value.element_type,
  first_market.position,
  source_value.value,
  first_market.selected_by_percent,
  first_market.transfers_in,
  first_market.transfers_out,
  first_market.transfers_in_event,
  first_market.transfers_out_event,
  first_market.status,
  first_market.news,
  first_market.news_added,
  first_market.chance_of_playing_this_round,
  first_market.chance_of_playing_next_round,
  source_value.created_at,
  source_value.created_at
FROM public.player_values source_value
JOIN fpl.seasons season ON season.season_code = '2627'
JOIN LATERAL (
  SELECT market.*
  FROM fpl.player_market_snapshots market
  WHERE market.season_id = season.season_id
    AND market.element_id = source_value.element_id
    AND market.snapshot_source = 'upstream'
  ORDER BY market.snapshot_date
  LIMIT 1
) first_market ON true
WHERE source_value.change_type = 'start'
  AND NOT EXISTS (
    SELECT 1
    FROM fpl.player_market_snapshots existing
    WHERE existing.season_id = season.season_id
      AND existing.element_id = source_value.element_id
      AND existing.snapshot_date <= to_date(btrim(source_value.change_date), 'YYYYMMDD')
  )
ON CONFLICT (season_id, snapshot_date, element_id) DO NOTHING;

DO $fpl_count_reconciliation$
DECLARE
  source_count bigint;
  target_count bigint;
BEGIN
  SELECT count(*) INTO source_count FROM public.teams_history WHERE season <> '2627';
  source_count := source_count + (SELECT count(*) FROM public.teams);
  SELECT count(*) INTO target_count FROM fpl.teams;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'fpl.teams count mismatch: source %, target %', source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.players_history WHERE season <> '2627';
  source_count := source_count + (SELECT count(*) FROM public.players);
  SELECT count(*) INTO target_count FROM fpl.players;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'fpl.players count mismatch: source %, target %', source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.events_history WHERE season <> '2627';
  source_count := source_count + (SELECT count(*) FROM public.events);
  SELECT count(*) INTO target_count FROM fpl.events;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'fpl.events count mismatch: source %, target %', source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.phases_history WHERE season <> '2627';
  source_count := source_count + (SELECT count(*) FROM public.phases);
  SELECT count(*) INTO target_count FROM fpl.phases;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'fpl.phases count mismatch: source %, target %', source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.event_fixtures_history WHERE season <> '2627';
  source_count := source_count + (SELECT count(*) FROM public.event_fixtures);
  SELECT count(*) INTO target_count FROM fpl.fixtures;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'fpl.fixtures count mismatch: source %, target %', source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.player_stats_history WHERE season <> '2627';
  source_count := source_count + (SELECT count(*) FROM public.player_stats);
  SELECT count(*) INTO target_count FROM fpl.player_event_snapshots;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'fpl.player_event_snapshots count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count FROM public.event_lives_history WHERE season <> '2627';
  source_count := source_count + (SELECT count(*) FROM public.event_lives);
  SELECT count(*) INTO target_count FROM fpl.player_gameweek_stats;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'fpl.player_gameweek_stats count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  WITH source_explains AS (
    SELECT
      minutes,
      minutes_points,
      goals_scored,
      goals_scored_points,
      assists,
      assists_points,
      clean_sheets,
      clean_sheets_points,
      goals_conceded,
      goals_conceded_points,
      own_goals,
      own_goals_points,
      penalties_saved,
      penalties_saved_points,
      penalties_missed,
      penalties_missed_points,
      yellow_cards,
      yellow_cards_points,
      red_cards,
      red_cards_points,
      saves,
      saves_points,
      bonus,
      defensive_contribution,
      defensive_contribution_points
    FROM public.event_live_explains_history
    WHERE season <> '2627'

    UNION ALL

    SELECT
      minutes,
      minutes_points,
      goals_scored,
      goals_scored_points,
      assists,
      assists_points,
      clean_sheets,
      clean_sheets_points,
      goals_conceded,
      goals_conceded_points,
      own_goals,
      own_goals_points,
      penalties_saved,
      penalties_saved_points,
      penalties_missed,
      penalties_missed_points,
      yellow_cards,
      yellow_cards_points,
      red_cards,
      red_cards_points,
      saves,
      saves_points,
      bonus,
      defensive_contribution,
      defensive_contribution_points
    FROM public.event_live_explains
  ), normalized AS (
    SELECT 1
    FROM source_explains source
    CROSS JOIN LATERAL (
      VALUES
        (source.minutes, source.minutes_points),
        (source.goals_scored, source.goals_scored_points),
        (source.assists, source.assists_points),
        (source.clean_sheets, source.clean_sheets_points),
        (source.goals_conceded, source.goals_conceded_points),
        (source.own_goals, source.own_goals_points),
        (source.penalties_saved, source.penalties_saved_points),
        (source.penalties_missed, source.penalties_missed_points),
        (source.yellow_cards, source.yellow_cards_points),
        (source.red_cards, source.red_cards_points),
        (source.saves, source.saves_points),
        (source.bonus, source.bonus),
        (source.defensive_contribution, source.defensive_contribution_points)
    ) AS metric(scoring_value, points)
    WHERE COALESCE(metric.scoring_value, 0) <> 0 OR COALESCE(metric.points, 0) <> 0
  )
  SELECT count(*) INTO source_count FROM normalized;
  SELECT count(*) INTO target_count FROM fpl.player_gameweek_scoring_items;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'fpl.player_gameweek_scoring_items count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count
  FROM public.fpl_player_fixture_stats_history
  WHERE season <> '2627';
  source_count := source_count + (SELECT count(*) FROM public.fpl_player_fixture_stats);
  SELECT count(*) INTO target_count FROM fpl.player_fixture_stats;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'fpl.player_fixture_stats count mismatch: source %, target %',
      source_count, target_count;
  END IF;

  SELECT count(*) INTO source_count
  FROM public.player_market_snapshots_history
  WHERE season <> '2627';
  source_count := source_count + (SELECT count(*) FROM public.player_market_snapshots);
  source_count := source_count + (
    SELECT count(*)
    FROM public.player_values source_value
    WHERE source_value.change_type = 'start'
      AND NOT EXISTS (
        SELECT 1
        FROM public.player_market_snapshots source_market
        WHERE source_market.element_id = source_value.element_id
          AND source_market.snapshot_date <= to_date(btrim(source_value.change_date), 'YYYYMMDD')
      )
  );
  SELECT count(*) INTO target_count FROM fpl.player_market_snapshots;
  IF source_count <> target_count THEN
    RAISE EXCEPTION 'fpl.player_market_snapshots count mismatch: expected %, target %',
      source_count, target_count;
  END IF;

  IF (SELECT count(*) FROM fpl.player_market_snapshots WHERE snapshot_source = 'legacy_value_seed')
     <> (
       SELECT count(*)
       FROM public.player_values source_value
       WHERE source_value.change_type = 'start'
         AND NOT EXISTS (
           SELECT 1
           FROM public.player_market_snapshots source_market
           WHERE source_market.element_id = source_value.element_id
             AND source_market.snapshot_date <= to_date(btrim(source_value.change_date), 'YYYYMMDD')
         )
     ) THEN
    RAISE EXCEPTION 'legacy value seed count mismatch';
  END IF;
END
$fpl_count_reconciliation$;

DO $value_reconstruction$
DECLARE
  mismatch_count bigint;
BEGIN
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
    RAISE EXCEPTION 'reporting.player_value_changes mismatch count %', mismatch_count;
  END IF;
END
$value_reconstruction$;

DO $summary_reconstruction$
DECLARE
  mismatch_count bigint;
BEGIN
  WITH source_summaries AS (
    SELECT
      season.season_id,
      source.element_id,
      source.element_type,
      source.minutes,
      source.goals_scored,
      source.assists,
      source.clean_sheets,
      source.goals_conceded,
      source.own_goals,
      source.penalties_saved,
      source.penalties_missed,
      source.yellow_cards,
      source.red_cards,
      source.saves,
      source.bonus,
      source.bps,
      source.total_points
    FROM public.event_live_summaries_history source
    JOIN fpl.seasons season ON season.season_code = source.season
    WHERE source.season <> '2627'
  ), target_summaries AS (
    SELECT
      target.season_id,
      target.element_id,
      target.element_type,
      target.minutes,
      target.goals_scored,
      target.assists,
      target.clean_sheets,
      target.goals_conceded,
      target.own_goals,
      target.penalties_saved,
      target.penalties_missed,
      target.yellow_cards,
      target.red_cards,
      target.saves,
      target.bonus,
      target.bps,
      target.total_points
    FROM reporting.player_season_summaries target
    JOIN fpl.seasons season ON season.season_id = target.season_id
    WHERE season.lifecycle_state = 'completed'
  ), differences AS (
    (SELECT * FROM source_summaries EXCEPT SELECT * FROM target_summaries)
    UNION ALL
    (SELECT * FROM target_summaries EXCEPT SELECT * FROM source_summaries)
  )
  SELECT count(*) INTO mismatch_count FROM differences;

  IF mismatch_count <> 0 THEN
    RAISE EXCEPTION 'reporting.player_season_summaries mismatch count %', mismatch_count;
  END IF;
END
$summary_reconstruction$;

CREATE TEMPORARY TABLE v3_fpl_reconciliation_specs (
  check_name text PRIMARY KEY,
  source_object text NOT NULL,
  target_object text NOT NULL,
  source_query text NOT NULL,
  target_query text NOT NULL
) ON COMMIT DROP;

INSERT INTO v3_fpl_reconciliation_specs (
  check_name,
  source_object,
  target_object,
  source_query,
  target_query
)
VALUES
  (
    '0085_fpl_teams_keyset',
    'public.teams_history + public.teams',
    'fpl.teams',
    $source$SELECT concat_ws(':', season, id)::text AS canonical_row
      FROM public.teams_history WHERE season <> '2627'
      UNION ALL
      SELECT concat_ws(':', '2627', id)::text FROM public.teams$source$,
    $target$SELECT concat_ws(':', season.season_code, target.team_id)::text AS canonical_row
      FROM fpl.teams target
      JOIN fpl.seasons season ON season.season_id = target.season_id$target$
  ),
  (
    '0085_fpl_players_keyset',
    'public.players_history + public.players',
    'fpl.players',
    $source$SELECT concat_ws(':', season, id)::text AS canonical_row
      FROM public.players_history WHERE season <> '2627'
      UNION ALL
      SELECT concat_ws(':', '2627', id)::text FROM public.players$source$,
    $target$SELECT concat_ws(':', season.season_code, target.element_id)::text AS canonical_row
      FROM fpl.players target
      JOIN fpl.seasons season ON season.season_id = target.season_id$target$
  ),
  (
    '0085_fpl_events_keyset',
    'public.events_history + public.events',
    'fpl.events',
    $source$SELECT concat_ws(':', season, id)::text AS canonical_row
      FROM public.events_history WHERE season <> '2627'
      UNION ALL
      SELECT concat_ws(':', '2627', id)::text FROM public.events$source$,
    $target$SELECT concat_ws(':', season.season_code, target.event_id)::text AS canonical_row
      FROM fpl.events target
      JOIN fpl.seasons season ON season.season_id = target.season_id$target$
  ),
  (
    '0085_fpl_phases_keyset',
    'public.phases_history + public.phases',
    'fpl.phases',
    $source$SELECT concat_ws(':', season, id)::text AS canonical_row
      FROM public.phases_history WHERE season <> '2627'
      UNION ALL
      SELECT concat_ws(':', '2627', id)::text FROM public.phases$source$,
    $target$SELECT concat_ws(':', season.season_code, target.phase_id)::text AS canonical_row
      FROM fpl.phases target
      JOIN fpl.seasons season ON season.season_id = target.season_id$target$
  ),
  (
    '0085_fpl_fixtures_keyset',
    'public.event_fixtures_history + public.event_fixtures',
    'fpl.fixtures',
    $source$SELECT concat_ws(':', season, id)::text AS canonical_row
      FROM public.event_fixtures_history WHERE season <> '2627'
      UNION ALL
      SELECT concat_ws(':', '2627', id)::text FROM public.event_fixtures$source$,
    $target$SELECT concat_ws(':', season.season_code, target.fixture_id)::text AS canonical_row
      FROM fpl.fixtures target
      JOIN fpl.seasons season ON season.season_id = target.season_id$target$
  ),
  (
    '0085_fpl_player_event_snapshots_keyset',
    'public.player_stats_history + public.player_stats',
    'fpl.player_event_snapshots',
    $source$SELECT concat_ws(':', season, event_id, element_id)::text AS canonical_row
      FROM public.player_stats_history WHERE season <> '2627'
      UNION ALL
      SELECT concat_ws(':', '2627', event_id, element_id)::text FROM public.player_stats$source$,
    $target$SELECT concat_ws(
        ':', season.season_code, target.event_id, target.element_id
      )::text AS canonical_row
      FROM fpl.player_event_snapshots target
      JOIN fpl.seasons season ON season.season_id = target.season_id$target$
  ),
  (
    '0085_fpl_player_gameweek_stats_keyset',
    'public.event_lives_history + public.event_lives',
    'fpl.player_gameweek_stats',
    $source$SELECT concat_ws(':', season, event_id, element_id)::text AS canonical_row
      FROM public.event_lives_history WHERE season <> '2627'
      UNION ALL
      SELECT concat_ws(':', '2627', event_id, element_id)::text FROM public.event_lives$source$,
    $target$SELECT concat_ws(
        ':', season.season_code, target.event_id, target.element_id
      )::text AS canonical_row
      FROM fpl.player_gameweek_stats target
      JOIN fpl.seasons season ON season.season_id = target.season_id$target$
  ),
  (
    '0085_fpl_player_gameweek_scoring_items_keyset',
    'public.event_live_explains_history + public.event_live_explains',
    'fpl.player_gameweek_scoring_items',
    $source$WITH source_explains AS (
        SELECT
          season,
          event_id,
          element_id,
          minutes,
          minutes_points,
          goals_scored,
          goals_scored_points,
          assists,
          assists_points,
          clean_sheets,
          clean_sheets_points,
          goals_conceded,
          goals_conceded_points,
          own_goals,
          own_goals_points,
          penalties_saved,
          penalties_saved_points,
          penalties_missed,
          penalties_missed_points,
          yellow_cards,
          yellow_cards_points,
          red_cards,
          red_cards_points,
          saves,
          saves_points,
          bonus,
          defensive_contribution,
          defensive_contribution_points
        FROM public.event_live_explains_history
        WHERE season <> '2627'
        UNION ALL
        SELECT
          '2627',
          event_id,
          element_id,
          minutes,
          minutes_points,
          goals_scored,
          goals_scored_points,
          assists,
          assists_points,
          clean_sheets,
          clean_sheets_points,
          goals_conceded,
          goals_conceded_points,
          own_goals,
          own_goals_points,
          penalties_saved,
          penalties_saved_points,
          penalties_missed,
          penalties_missed_points,
          yellow_cards,
          yellow_cards_points,
          red_cards,
          red_cards_points,
          saves,
          saves_points,
          bonus,
          defensive_contribution,
          defensive_contribution_points
        FROM public.event_live_explains
      )
      SELECT concat_ws(
        ':', source.season, source.event_id, source.element_id, metric.identifier
      )::text AS canonical_row
      FROM source_explains source
      CROSS JOIN LATERAL (VALUES
        ('minutes', source.minutes, source.minutes_points),
        ('goals_scored', source.goals_scored, source.goals_scored_points),
        ('assists', source.assists, source.assists_points),
        ('clean_sheets', source.clean_sheets, source.clean_sheets_points),
        ('goals_conceded', source.goals_conceded, source.goals_conceded_points),
        ('own_goals', source.own_goals, source.own_goals_points),
        ('penalties_saved', source.penalties_saved, source.penalties_saved_points),
        ('penalties_missed', source.penalties_missed, source.penalties_missed_points),
        ('yellow_cards', source.yellow_cards, source.yellow_cards_points),
        ('red_cards', source.red_cards, source.red_cards_points),
        ('saves', source.saves, source.saves_points),
        ('bonus', source.bonus, source.bonus),
        (
          'defensive_contribution',
          source.defensive_contribution,
          source.defensive_contribution_points
        )
      ) metric(identifier, scoring_value, points)
      WHERE COALESCE(metric.scoring_value, 0) <> 0 OR COALESCE(metric.points, 0) <> 0$source$,
    $target$SELECT concat_ws(
        ':',
        season.season_code,
        target.event_id,
        target.element_id,
        target.scoring_identifier
      )::text AS canonical_row
      FROM fpl.player_gameweek_scoring_items target
      JOIN fpl.seasons season ON season.season_id = target.season_id$target$
  ),
  (
    '0085_fpl_player_fixture_stats_keyset',
    'public.fpl_player_fixture_stats_history + public.fpl_player_fixture_stats',
    'fpl.player_fixture_stats',
    $source$SELECT concat_ws(':', season, fixture_id, element_id)::text AS canonical_row
      FROM public.fpl_player_fixture_stats_history WHERE season <> '2627'
      UNION ALL
      SELECT concat_ws(':', season, fixture_id, element_id)::text
      FROM public.fpl_player_fixture_stats$source$,
    $target$SELECT concat_ws(
        ':', season.season_code, target.fixture_id, target.element_id
      )::text AS canonical_row
      FROM fpl.player_fixture_stats target
      JOIN fpl.seasons season ON season.season_id = target.season_id$target$
  ),
  (
    '0085_fpl_player_market_snapshots_keyset',
    'public.player_market_snapshots* + required start-value seeds',
    'fpl.player_market_snapshots',
    $source$SELECT concat_ws(':', season, snapshot_date, element_id)::text AS canonical_row
      FROM public.player_market_snapshots_history WHERE season <> '2627'
      UNION ALL
      SELECT concat_ws(':', '2627', snapshot_date, element_id)::text
      FROM public.player_market_snapshots
      UNION ALL
      SELECT concat_ws(
        ':', '2627', to_date(btrim(source_value.change_date), 'YYYYMMDD'), source_value.element_id
      )::text
      FROM public.player_values source_value
      WHERE source_value.change_type = 'start'
        AND NOT EXISTS (
          SELECT 1
          FROM public.player_market_snapshots source_market
          WHERE source_market.element_id = source_value.element_id
            AND source_market.snapshot_date <= to_date(
              btrim(source_value.change_date), 'YYYYMMDD'
            )
        )$source$,
    $target$SELECT concat_ws(
        ':', season.season_code, target.snapshot_date, target.element_id
      )::text AS canonical_row
      FROM fpl.player_market_snapshots target
      JOIN fpl.seasons season ON season.season_id = target.season_id$target$
  ),
  (
    '0085_reporting_player_value_changes_rows',
    'public.player_values_history + public.player_values',
    'reporting.player_value_changes',
    $source$SELECT jsonb_build_array(
        season,
        element_id,
        element_type,
        event_id,
        value,
        btrim(change_date),
        last_value,
        change_type::text
      )::text AS canonical_row
      FROM public.player_values_history WHERE season <> '2627'
      UNION ALL
      SELECT jsonb_build_array(
        '2627',
        element_id,
        element_type,
        event_id,
        value,
        btrim(change_date),
        last_value,
        change_type::text
      )::text
      FROM public.player_values$source$,
    $target$SELECT jsonb_build_array(
        target.season_code,
        target.element_id,
        target.element_type,
        target.event_id,
        target.value,
        to_char(target.snapshot_date, 'YYYYMMDD'),
        target.last_value,
        target.change_type::text
      )::text AS canonical_row
      FROM reporting.player_value_changes target$target$
  ),
  (
    '0085_reporting_player_season_summaries_rows',
    'public.event_live_summaries_history',
    'reporting.player_season_summaries',
    $source$SELECT jsonb_build_array(
        season,
        element_id,
        element_type,
        minutes,
        goals_scored,
        assists,
        clean_sheets,
        goals_conceded,
        own_goals,
        penalties_saved,
        penalties_missed,
        yellow_cards,
        red_cards,
        saves,
        bonus,
        bps,
        total_points
      )::text AS canonical_row
      FROM public.event_live_summaries_history
      WHERE season <> '2627'$source$,
    $target$SELECT jsonb_build_array(
        season.season_code,
        target.element_id,
        target.element_type,
        target.minutes,
        target.goals_scored,
        target.assists,
        target.clean_sheets,
        target.goals_conceded,
        target.own_goals,
        target.penalties_saved,
        target.penalties_missed,
        target.yellow_cards,
        target.red_cards,
        target.saves,
        target.bonus,
        target.bps,
        target.total_points
      )::text AS canonical_row
      FROM reporting.player_season_summaries target
      JOIN fpl.seasons season ON season.season_id = target.season_id
      WHERE season.lifecycle_state = 'completed'$target$
  );

DO $record_fpl_reconciliation_evidence$
DECLARE
  spec record;
  source_count bigint;
  source_hash text;
  target_count bigint;
  target_hash text;
BEGIN
  FOR spec IN SELECT * FROM v3_fpl_reconciliation_specs ORDER BY check_name
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
      RAISE EXCEPTION 'FPL reconciliation failed for %: source count/hash %/%, target %/%',
        spec.check_name,
        source_count,
        source_hash,
        target_count,
        target_hash;
    END IF;
  END LOOP;
END
$record_fpl_reconciliation_evidence$;

ANALYZE fpl.events;
ANALYZE fpl.teams;
ANALYZE fpl.players;
ANALYZE fpl.phases;
ANALYZE fpl.fixtures;
ANALYZE fpl.player_event_snapshots;
ANALYZE fpl.player_gameweek_stats;
ANALYZE fpl.player_gameweek_scoring_items;
ANALYZE fpl.player_fixture_stats;
ANALYZE fpl.player_market_snapshots;

RESET ROLE;
