-- Season-aware entry, league, and tournament facts.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE letletme_data_owner;

DO $competition_enums$
BEGIN
  IF to_regtype('competition.chip') IS NULL THEN
    CREATE TYPE competition.chip AS ENUM ('n/a', 'wildcard', 'freehit', 'bboost', '3xc', 'manager');
  END IF;
  IF to_regtype('competition.cup_result') IS NULL THEN
    CREATE TYPE competition.cup_result AS ENUM ('win', 'loss');
  END IF;
  IF to_regtype('competition.group_mode') IS NULL THEN
    CREATE TYPE competition.group_mode AS ENUM ('no_group', 'points_races', 'battle_races');
  END IF;
  IF to_regtype('competition.knockout_mode') IS NULL THEN
    CREATE TYPE competition.knockout_mode AS ENUM (
      'no_knockout', 'single_elimination', 'double_elimination', 'head_to_head'
    );
  END IF;
  IF to_regtype('competition.league_type') IS NULL THEN
    CREATE TYPE competition.league_type AS ENUM ('classic', 'h2h');
  END IF;
  IF to_regtype('competition.tournament_mode') IS NULL THEN
    CREATE TYPE competition.tournament_mode AS ENUM ('normal');
  END IF;
  IF to_regtype('competition.tournament_roster_mode') IS NULL THEN
    CREATE TYPE competition.tournament_roster_mode AS ENUM ('snapshot', 'official_sync');
  END IF;
  IF to_regtype('competition.tournament_setup_phase') IS NULL THEN
    CREATE TYPE competition.tournament_setup_phase AS ENUM (
      'queued',
      'syncing_entries',
      'building_structure',
      'calculating_standings',
      'enriching_history',
      'finalizing',
      'ready',
      'failed'
    );
  END IF;
  IF to_regtype('competition.tournament_setup_status') IS NULL THEN
    CREATE TYPE competition.tournament_setup_status AS ENUM ('pending', 'processing', 'ready', 'failed');
  END IF;
  IF to_regtype('competition.tournament_state') IS NULL THEN
    CREATE TYPE competition.tournament_state AS ENUM ('active', 'inactive', 'finished');
  END IF;
END
$competition_enums$;

CREATE TABLE IF NOT EXISTS competition.entries (
  season_id smallint NOT NULL,
  entry_id integer NOT NULL,
  entry_name text NOT NULL,
  player_name text NOT NULL,
  region text,
  started_event integer,
  overall_points integer,
  overall_rank integer,
  bank integer,
  team_value integer,
  total_transfers integer,
  last_entry_name text,
  last_overall_points integer,
  last_overall_rank integer,
  last_team_value integer,
  last_bank integer,
  used_entry_names text[] NOT NULL DEFAULT '{}',
  last_event_id integer NOT NULL DEFAULT 0,
  snapshot_synced_through_event_id integer,
  transfers_synced_through_event_id integer,
  transfers_source_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entries_pkey PRIMARY KEY (season_id, entry_id),
  CONSTRAINT entries_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT entries_entry_id_positive CHECK (entry_id > 0),
  CONSTRAINT entries_names_nonempty CHECK (btrim(entry_name) <> '' AND btrim(player_name) <> ''),
  CONSTRAINT entries_event_ids_valid CHECK (
    (started_event IS NULL OR started_event > 0)
    AND last_event_id >= 0
    AND (snapshot_synced_through_event_id IS NULL OR snapshot_synced_through_event_id >= 0)
    AND (transfers_synced_through_event_id IS NULL OR transfers_synced_through_event_id >= 0)
  )
);

CREATE INDEX IF NOT EXISTS entries_entry_id_idx
  ON competition.entries (entry_id, season_id DESC);

CREATE TABLE IF NOT EXISTS competition.entry_season_histories (
  season_id smallint NOT NULL,
  entry_id integer NOT NULL,
  source_history_id integer NOT NULL,
  source_season_label text NOT NULL,
  total_points integer NOT NULL DEFAULT 0,
  overall_rank integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entry_season_histories_pkey PRIMARY KEY (season_id, entry_id),
  CONSTRAINT entry_season_histories_season_fk FOREIGN KEY (season_id)
    REFERENCES fpl.seasons(season_id),
  CONSTRAINT entry_season_histories_source_id_unique UNIQUE (source_history_id),
  CONSTRAINT entry_season_histories_ids_positive CHECK (
    entry_id > 0 AND source_history_id > 0
  ),
  CONSTRAINT entry_season_histories_totals_nonnegative CHECK (
    total_points >= 0 AND overall_rank >= 0
  ),
  CONSTRAINT entry_season_histories_label_format CHECK (
    source_season_label ~ '^[0-9]{4}/[0-9]{2}$'
  )
);

CREATE INDEX IF NOT EXISTS entry_season_histories_entry_idx
  ON competition.entry_season_histories (entry_id, season_id DESC);

CREATE TABLE IF NOT EXISTS competition.entry_leagues (
  season_id smallint NOT NULL,
  entry_id integer NOT NULL,
  league_id integer NOT NULL,
  league_type competition.league_type NOT NULL,
  source_entry_league_id integer NOT NULL,
  league_name text NOT NULL,
  started_event integer,
  entry_rank integer,
  entry_last_rank integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entry_leagues_pkey PRIMARY KEY (season_id, entry_id, league_id, league_type),
  CONSTRAINT entry_leagues_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT entry_leagues_source_id_unique UNIQUE (source_entry_league_id),
  CONSTRAINT entry_leagues_ids_positive CHECK (
    entry_id > 0 AND league_id > 0 AND source_entry_league_id > 0
  ),
  CONSTRAINT entry_leagues_name_nonempty CHECK (btrim(league_name) <> ''),
  CONSTRAINT entry_leagues_started_event_positive CHECK (started_event IS NULL OR started_event > 0)
);

CREATE INDEX IF NOT EXISTS entry_leagues_league_idx
  ON competition.entry_leagues (season_id, league_id, league_type);

CREATE TABLE IF NOT EXISTS competition.entry_event_picks (
  season_id smallint NOT NULL,
  entry_id integer NOT NULL,
  event_id integer NOT NULL,
  position smallint NOT NULL,
  element_id integer NOT NULL,
  multiplier smallint NOT NULL,
  is_captain boolean NOT NULL,
  is_vice_captain boolean NOT NULL,
  active_chip competition.chip,
  transfers integer,
  transfers_cost integer,
  source_pick_row_id integer NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  CONSTRAINT entry_event_picks_pkey PRIMARY KEY (season_id, entry_id, event_id, position),
  CONSTRAINT entry_event_picks_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT entry_event_picks_ids_positive CHECK (
    entry_id > 0 AND event_id > 0 AND element_id > 0 AND source_pick_row_id > 0
  ),
  CONSTRAINT entry_event_picks_position_valid CHECK (position BETWEEN 1 AND 15),
  CONSTRAINT entry_event_picks_multiplier_valid CHECK (multiplier BETWEEN 0 AND 3),
  CONSTRAINT entry_event_picks_captain_roles_distinct CHECK (NOT (is_captain AND is_vice_captain)),
  CONSTRAINT entry_event_picks_event_metadata_once CHECK (
    (position = 1)
    OR (active_chip IS NULL AND transfers IS NULL AND transfers_cost IS NULL)
  ),
  CONSTRAINT entry_event_picks_transfer_counts_nonnegative CHECK (
    (transfers IS NULL OR transfers >= 0) AND (transfers_cost IS NULL OR transfers_cost >= 0)
  ),
  CONSTRAINT entry_event_picks_source_time_order CHECK (source_updated_at >= source_created_at),
  CONSTRAINT entry_event_picks_element_once UNIQUE (season_id, entry_id, event_id, element_id)
);

CREATE INDEX IF NOT EXISTS entry_event_picks_event_idx
  ON competition.entry_event_picks (season_id, event_id, entry_id);
CREATE INDEX IF NOT EXISTS entry_event_picks_element_idx
  ON competition.entry_event_picks (season_id, event_id, element_id);
CREATE INDEX IF NOT EXISTS entry_event_picks_source_row_idx
  ON competition.entry_event_picks (source_pick_row_id);

CREATE TABLE IF NOT EXISTS competition.entry_event_results (
  season_id smallint NOT NULL,
  entry_id integer NOT NULL,
  event_id integer NOT NULL,
  source_result_id integer NOT NULL,
  event_points integer NOT NULL DEFAULT 0,
  event_transfers integer NOT NULL DEFAULT 0,
  event_transfers_cost integer NOT NULL DEFAULT 0,
  event_net_points integer NOT NULL DEFAULT 0,
  event_bench_points integer,
  event_auto_sub_points integer,
  event_rank integer,
  event_chip competition.chip,
  played_captain_element_id integer,
  captain_points integer,
  automatic_substitutions jsonb,
  overall_points integer NOT NULL DEFAULT 0,
  overall_rank integer NOT NULL DEFAULT 0,
  team_value integer,
  bank integer,
  rich_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entry_event_results_pkey PRIMARY KEY (season_id, entry_id, event_id),
  CONSTRAINT entry_event_results_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT entry_event_results_source_id_unique UNIQUE (source_result_id),
  CONSTRAINT entry_event_results_ids_positive CHECK (
    entry_id > 0 AND event_id > 0 AND source_result_id > 0
    AND (played_captain_element_id IS NULL OR played_captain_element_id > 0)
  ),
  CONSTRAINT entry_event_results_transfer_counts_nonnegative CHECK (
    event_transfers >= 0 AND event_transfers_cost >= 0
  ),
  CONSTRAINT entry_event_results_rank_nonnegative CHECK (
    (event_rank IS NULL OR event_rank >= 0) AND overall_rank >= 0
  ),
  CONSTRAINT entry_event_results_auto_sub_array CHECK (
    automatic_substitutions IS NULL OR jsonb_typeof(automatic_substitutions) = 'array'
  )
);

CREATE INDEX IF NOT EXISTS entry_event_results_event_idx
  ON competition.entry_event_results (season_id, event_id, entry_id);
CREATE INDEX IF NOT EXISTS entry_event_results_captain_idx
  ON competition.entry_event_results (season_id, played_captain_element_id)
  WHERE played_captain_element_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS competition.entry_event_transfers (
  season_id smallint NOT NULL,
  transfer_id integer GENERATED BY DEFAULT AS IDENTITY,
  entry_id integer NOT NULL,
  event_id integer NOT NULL,
  element_in_id integer,
  element_in_cost integer,
  element_in_points integer,
  element_out_id integer,
  element_out_cost integer,
  element_out_points integer,
  element_in_played boolean,
  transfer_time timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entry_event_transfers_pkey PRIMARY KEY (season_id, transfer_id),
  CONSTRAINT entry_event_transfers_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT entry_event_transfers_ids_positive CHECK (
    transfer_id > 0 AND entry_id > 0 AND event_id > 0
    AND (element_in_id IS NULL OR element_in_id > 0)
    AND (element_out_id IS NULL OR element_out_id > 0)
  )
);

CREATE INDEX IF NOT EXISTS entry_event_transfers_entry_event_idx
  ON competition.entry_event_transfers (season_id, entry_id, event_id, transfer_time, transfer_id);
CREATE INDEX IF NOT EXISTS entry_event_transfers_element_in_idx
  ON competition.entry_event_transfers (season_id, element_in_id)
  WHERE element_in_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entry_event_transfers_element_out_idx
  ON competition.entry_event_transfers (season_id, element_out_id)
  WHERE element_out_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS competition.entry_event_cup_results (
  season_id smallint NOT NULL,
  source_result_id integer NOT NULL,
  entry_id integer NOT NULL,
  event_id integer NOT NULL,
  opponent_entry_id integer,
  opponent_name text,
  result competition.cup_result NOT NULL,
  entry_points integer NOT NULL,
  opponent_points integer NOT NULL,
  entry_name text,
  player_name text,
  against_entry_name text,
  against_player_name text,
  event_points integer,
  against_entry_id integer,
  against_event_points integer,
  source_season_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entry_event_cup_results_pkey PRIMARY KEY (season_id, source_result_id),
  CONSTRAINT entry_event_cup_results_season_fk FOREIGN KEY (season_id)
    REFERENCES fpl.seasons(season_id),
  CONSTRAINT entry_event_cup_results_ids_positive CHECK (
    source_result_id > 0 AND entry_id > 0 AND event_id > 0
    AND (opponent_entry_id IS NULL OR opponent_entry_id > 0)
    AND (against_entry_id IS NULL OR against_entry_id > 0)
  )
);

CREATE INDEX IF NOT EXISTS entry_event_cup_results_entry_event_idx
  ON competition.entry_event_cup_results (season_id, entry_id, event_id);

CREATE TABLE IF NOT EXISTS competition.league_event_results (
  season_id smallint NOT NULL,
  source_result_id integer GENERATED BY DEFAULT AS IDENTITY,
  league_id integer NOT NULL,
  league_type competition.league_type NOT NULL,
  entry_id integer NOT NULL,
  event_id integer NOT NULL,
  event_points integer NOT NULL DEFAULT 0,
  event_transfers integer NOT NULL DEFAULT 0,
  event_transfers_cost integer NOT NULL DEFAULT 0,
  event_net_points integer NOT NULL DEFAULT 0,
  overall_points integer NOT NULL DEFAULT 0,
  overall_rank integer NOT NULL DEFAULT 0,
  entry_name text,
  player_name text,
  team_value integer,
  bank integer,
  event_bench_points integer,
  event_auto_sub_points integer,
  event_rank integer,
  event_chip competition.chip,
  captain_element_id integer,
  captain_points integer,
  captain_blank boolean,
  vice_captain_element_id integer,
  vice_captain_points integer,
  vice_captain_blank boolean,
  played_captain_element_id integer,
  highest_score_element_id integer,
  highest_score_points integer,
  highest_score_blank boolean,
  source_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT league_event_results_pkey PRIMARY KEY (season_id, source_result_id),
  CONSTRAINT league_event_results_season_fk FOREIGN KEY (season_id)
    REFERENCES fpl.seasons(season_id),
  CONSTRAINT league_event_results_business_unique
    UNIQUE (season_id, league_id, league_type, entry_id, event_id),
  CONSTRAINT league_event_results_ids_positive CHECK (
    source_result_id > 0 AND league_id > 0 AND entry_id > 0 AND event_id > 0
  ),
  CONSTRAINT league_event_results_transfer_counts_nonnegative CHECK (
    event_transfers >= 0 AND event_transfers_cost >= 0
  )
);

CREATE INDEX IF NOT EXISTS league_event_results_event_idx
  ON competition.league_event_results (season_id, event_id, league_id, league_type);
CREATE INDEX IF NOT EXISTS league_event_results_entry_idx
  ON competition.league_event_results (season_id, entry_id, event_id);

CREATE TABLE IF NOT EXISTS competition.tournaments (
  tournament_id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  season_id smallint NOT NULL,
  name text NOT NULL,
  creator text NOT NULL,
  admin_entry_id integer NOT NULL,
  league_id integer NOT NULL,
  league_type competition.league_type NOT NULL,
  total_team_num integer NOT NULL,
  tournament_mode competition.tournament_mode NOT NULL,
  group_mode competition.group_mode,
  group_team_num integer,
  group_num integer,
  group_started_event_id integer,
  group_ended_event_id integer,
  group_auto_averages boolean NOT NULL,
  group_rounds integer,
  group_play_against_num integer,
  group_qualify_num integer,
  knockout_mode competition.knockout_mode,
  knockout_team_num integer,
  knockout_rounds integer,
  knockout_event_num integer,
  knockout_started_event_id integer,
  knockout_ended_event_id integer,
  knockout_play_against_num integer,
  state competition.tournament_state NOT NULL,
  setup_status competition.tournament_setup_status NOT NULL DEFAULT 'pending',
  setup_error text,
  setup_started_at timestamptz,
  setup_finished_at timestamptz,
  source_league_name text,
  roster_mode competition.tournament_roster_mode NOT NULL DEFAULT 'snapshot',
  roster_sync_status competition.tournament_setup_status,
  roster_last_synced_at timestamptz,
  roster_sync_error text,
  setup_phase competition.tournament_setup_phase NOT NULL DEFAULT 'queued',
  setup_completed_units integer NOT NULL DEFAULT 0,
  setup_total_units integer NOT NULL DEFAULT 0,
  setup_progress_updated_at timestamptz,
  standings_ready_at timestamptz,
  setup_warning_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tournaments_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT tournaments_ids_positive CHECK (
    tournament_id > 0 AND admin_entry_id > 0 AND league_id > 0 AND total_team_num > 0
  ),
  CONSTRAINT tournaments_name_nonempty CHECK (btrim(name) <> '' AND btrim(creator) <> ''),
  CONSTRAINT tournaments_setup_counts_valid CHECK (
    setup_completed_units >= 0
    AND setup_total_units >= 0
    AND setup_completed_units <= setup_total_units
    AND setup_warning_count >= 0
  ),
  CONSTRAINT tournaments_group_event_order CHECK (
    group_ended_event_id IS NULL
    OR group_started_event_id IS NULL
    OR group_ended_event_id >= group_started_event_id
  ),
  CONSTRAINT tournaments_knockout_event_order CHECK (
    knockout_ended_event_id IS NULL
    OR knockout_started_event_id IS NULL
    OR knockout_ended_event_id >= knockout_started_event_id
  ),
  CONSTRAINT tournaments_setup_time_order CHECK (
    setup_finished_at IS NULL OR setup_started_at IS NULL OR setup_finished_at >= setup_started_at
  ),
  CONSTRAINT tournaments_season_identity_unique UNIQUE (season_id, tournament_id)
);

CREATE INDEX IF NOT EXISTS tournaments_league_idx
  ON competition.tournaments (season_id, league_id, league_type);
CREATE INDEX IF NOT EXISTS tournaments_admin_entry_idx
  ON competition.tournaments (season_id, admin_entry_id);
CREATE INDEX IF NOT EXISTS tournaments_state_idx
  ON competition.tournaments (season_id, state, setup_status);

CREATE TABLE IF NOT EXISTS competition.tournament_entries (
  tournament_id integer NOT NULL,
  season_id smallint NOT NULL,
  league_id integer NOT NULL,
  entry_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tournament_entries_pkey PRIMARY KEY (tournament_id, entry_id),
  CONSTRAINT tournament_entries_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT tournament_entries_ids_positive CHECK (
    tournament_id > 0 AND league_id > 0 AND entry_id > 0
  )
);

CREATE INDEX IF NOT EXISTS tournament_entries_season_entry_idx
  ON competition.tournament_entries (season_id, entry_id);

CREATE TABLE IF NOT EXISTS competition.tournament_groups (
  source_group_row_id integer GENERATED BY DEFAULT AS IDENTITY,
  tournament_id integer NOT NULL,
  season_id smallint NOT NULL,
  group_id integer NOT NULL,
  group_name text NOT NULL,
  group_index integer NOT NULL,
  entry_id integer NOT NULL,
  started_event_id integer,
  ended_event_id integer,
  group_points integer,
  group_rank integer,
  played integer,
  won integer,
  drawn integer,
  lost integer,
  total_points integer,
  total_transfers_cost integer,
  total_net_points integer,
  qualified integer,
  overall_rank integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tournament_groups_pkey PRIMARY KEY (tournament_id, group_id, entry_id),
  CONSTRAINT tournament_groups_source_id_unique UNIQUE (source_group_row_id),
  CONSTRAINT tournament_groups_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT tournament_groups_ids_positive CHECK (
    source_group_row_id > 0 AND tournament_id > 0 AND group_id > 0 AND entry_id > 0
  ),
  CONSTRAINT tournament_groups_name_nonempty CHECK (btrim(group_name) <> ''),
  CONSTRAINT tournament_groups_event_order CHECK (
    ended_event_id IS NULL OR started_event_id IS NULL OR ended_event_id >= started_event_id
  )
);

CREATE INDEX IF NOT EXISTS tournament_groups_entry_idx
  ON competition.tournament_groups (season_id, entry_id, tournament_id);

CREATE TABLE IF NOT EXISTS competition.tournament_knockouts (
  source_knockout_id integer GENERATED BY DEFAULT AS IDENTITY,
  tournament_id integer NOT NULL,
  season_id smallint NOT NULL,
  round integer NOT NULL,
  started_event_id integer,
  ended_event_id integer,
  match_id integer NOT NULL,
  next_match_id integer,
  home_entry_id integer,
  home_net_points integer,
  home_goals_scored integer,
  home_goals_conceded integer,
  home_wins integer,
  away_entry_id integer,
  away_net_points integer,
  away_goals_scored integer,
  away_goals_conceded integer,
  away_wins integer,
  round_winner integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tournament_knockouts_pkey PRIMARY KEY (tournament_id, match_id),
  CONSTRAINT tournament_knockouts_source_id_unique UNIQUE (source_knockout_id),
  CONSTRAINT tournament_knockouts_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT tournament_knockouts_ids_positive CHECK (
    source_knockout_id > 0 AND tournament_id > 0 AND round > 0 AND match_id > 0
  ),
  CONSTRAINT tournament_knockouts_event_order CHECK (
    ended_event_id IS NULL OR started_event_id IS NULL OR ended_event_id >= started_event_id
  )
);

CREATE INDEX IF NOT EXISTS tournament_knockouts_home_entry_idx
  ON competition.tournament_knockouts (season_id, home_entry_id)
  WHERE home_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tournament_knockouts_away_entry_idx
  ON competition.tournament_knockouts (season_id, away_entry_id)
  WHERE away_entry_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS competition.tournament_battle_group_results (
  source_result_id integer GENERATED BY DEFAULT AS IDENTITY,
  tournament_id integer NOT NULL,
  season_id smallint NOT NULL,
  group_id integer NOT NULL,
  event_id integer NOT NULL,
  home_index integer NOT NULL,
  home_entry_id integer NOT NULL,
  home_net_points integer,
  home_rank integer,
  home_match_points integer,
  away_index integer NOT NULL,
  away_entry_id integer NOT NULL,
  away_net_points integer,
  away_rank integer,
  away_match_points integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tournament_battle_group_results_pkey PRIMARY KEY (tournament_id, source_result_id),
  CONSTRAINT tournament_battle_group_results_season_fk FOREIGN KEY (season_id)
    REFERENCES fpl.seasons(season_id),
  CONSTRAINT tournament_battle_group_results_ids_positive CHECK (
    source_result_id > 0 AND tournament_id > 0 AND group_id > 0 AND event_id > 0
    AND home_entry_id > 0 AND away_entry_id > 0
  ),
  CONSTRAINT tournament_battle_group_results_distinct_entries CHECK (home_entry_id <> away_entry_id)
);

CREATE INDEX IF NOT EXISTS tournament_battle_group_results_event_idx
  ON competition.tournament_battle_group_results (season_id, event_id, tournament_id);

CREATE TABLE IF NOT EXISTS competition.tournament_points_group_results (
  source_result_id integer GENERATED BY DEFAULT AS IDENTITY,
  tournament_id integer NOT NULL,
  season_id smallint NOT NULL,
  group_id integer NOT NULL,
  event_id integer NOT NULL,
  entry_id integer NOT NULL,
  event_group_rank integer,
  event_points integer,
  event_cost integer,
  event_net_points integer,
  event_rank integer,
  cumulative_transfers integer NOT NULL DEFAULT 0,
  cumulative_costs integer NOT NULL DEFAULT 0,
  cumulative_bench_points integer NOT NULL DEFAULT 0,
  cumulative_auto_sub_points integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tournament_points_group_results_pkey PRIMARY KEY (tournament_id, source_result_id),
  CONSTRAINT tournament_points_group_results_business_unique
    UNIQUE (tournament_id, event_id, entry_id),
  CONSTRAINT tournament_points_group_results_season_fk FOREIGN KEY (season_id)
    REFERENCES fpl.seasons(season_id),
  CONSTRAINT tournament_points_group_results_ids_positive CHECK (
    source_result_id > 0 AND tournament_id > 0 AND group_id > 0 AND event_id > 0 AND entry_id > 0
  ),
  CONSTRAINT tournament_points_group_results_cumulative_nonnegative CHECK (
    cumulative_transfers >= 0
    AND cumulative_costs >= 0
    AND cumulative_bench_points >= 0
    AND cumulative_auto_sub_points >= 0
  )
);

CREATE INDEX IF NOT EXISTS tournament_points_group_results_event_idx
  ON competition.tournament_points_group_results (season_id, event_id, tournament_id);
CREATE INDEX IF NOT EXISTS tournament_points_group_results_entry_idx
  ON competition.tournament_points_group_results (season_id, entry_id, event_id);

CREATE TABLE IF NOT EXISTS competition.tournament_knockout_results (
  source_result_id integer GENERATED BY DEFAULT AS IDENTITY,
  tournament_id integer NOT NULL,
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  match_id integer NOT NULL,
  play_against_id integer NOT NULL,
  home_entry_id integer,
  home_net_points integer,
  home_goals_scored integer,
  home_goals_conceded integer,
  away_entry_id integer,
  away_net_points integer,
  away_goals_scored integer,
  away_goals_conceded integer,
  match_winner integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tournament_knockout_results_pkey PRIMARY KEY (tournament_id, source_result_id),
  CONSTRAINT tournament_knockout_results_business_unique
    UNIQUE (tournament_id, event_id, match_id, play_against_id),
  CONSTRAINT tournament_knockout_results_season_fk FOREIGN KEY (season_id)
    REFERENCES fpl.seasons(season_id),
  CONSTRAINT tournament_knockout_results_ids_positive CHECK (
    source_result_id > 0 AND tournament_id > 0 AND event_id > 0
    AND match_id > 0 AND play_against_id > 0
  ),
  CONSTRAINT tournament_knockout_results_distinct_entries CHECK (
    home_entry_id IS NULL OR away_entry_id IS NULL OR home_entry_id <> away_entry_id
  )
);

CREATE INDEX IF NOT EXISTS tournament_knockout_results_event_idx
  ON competition.tournament_knockout_results (season_id, event_id, tournament_id);

REVOKE ALL ON ALL TABLES IN SCHEMA competition FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA competition FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA competition
TO letletme_data_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA competition
TO letletme_data_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA competition
TO letletme_graphql_reader;

RESET ROLE;
