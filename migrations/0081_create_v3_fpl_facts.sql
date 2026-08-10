-- Stable FPL facts. All grains start with season_id and remain unpartitioned.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';
SET LOCAL ROLE letletme_data_owner;

CREATE TABLE IF NOT EXISTS fpl.fixtures (
  season_id smallint NOT NULL,
  fixture_id integer NOT NULL,
  code integer NOT NULL,
  event_id integer,
  kickoff_time timestamptz,
  started boolean NOT NULL DEFAULT false,
  finished boolean NOT NULL DEFAULT false,
  finished_provisional boolean NOT NULL DEFAULT false,
  provisional_start_time boolean NOT NULL DEFAULT false,
  minutes integer NOT NULL DEFAULT 0,
  team_h_id integer,
  team_h_difficulty integer,
  team_h_score integer,
  team_a_id integer,
  team_a_difficulty integer,
  team_a_score integer,
  stats jsonb NOT NULL DEFAULT '[]'::jsonb,
  pulse_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fixtures_pkey PRIMARY KEY (season_id, fixture_id),
  CONSTRAINT fixtures_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT fixtures_fixture_id_positive CHECK (fixture_id > 0),
  CONSTRAINT fixtures_code_positive CHECK (code > 0),
  CONSTRAINT fixtures_event_positive CHECK (event_id IS NULL OR event_id > 0),
  CONSTRAINT fixtures_minutes_valid CHECK (minutes BETWEEN 0 AND 180),
  CONSTRAINT fixtures_distinct_teams CHECK (
    team_h_id IS NULL OR team_a_id IS NULL OR team_h_id <> team_a_id
  ),
  CONSTRAINT fixtures_scores_nonnegative CHECK (
    (team_h_score IS NULL OR team_h_score >= 0)
    AND (team_a_score IS NULL OR team_a_score >= 0)
  ),
  CONSTRAINT fixtures_difficulty_valid CHECK (
    (team_h_difficulty IS NULL OR team_h_difficulty BETWEEN 0 AND 5)
    AND (team_a_difficulty IS NULL OR team_a_difficulty BETWEEN 0 AND 5)
  ),
  CONSTRAINT fixtures_stats_array CHECK (jsonb_typeof(stats) = 'array'),
  CONSTRAINT fixtures_season_code_unique UNIQUE (season_id, code)
);

CREATE INDEX IF NOT EXISTS fixtures_event_idx
  ON fpl.fixtures (season_id, event_id);
CREATE INDEX IF NOT EXISTS fixtures_home_team_idx
  ON fpl.fixtures (season_id, team_h_id);
CREATE INDEX IF NOT EXISTS fixtures_away_team_idx
  ON fpl.fixtures (season_id, team_a_id);
CREATE INDEX IF NOT EXISTS fixtures_kickoff_idx
  ON fpl.fixtures (season_id, kickoff_time);

CREATE TABLE IF NOT EXISTS fpl.player_event_snapshots (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  element_id integer NOT NULL,
  source_snapshot_id integer NOT NULL,
  element_type integer NOT NULL,
  total_points integer,
  form numeric,
  influence numeric,
  creativity numeric,
  threat numeric,
  ict_index numeric,
  expected_goals numeric,
  expected_assists numeric,
  expected_goal_involvements numeric,
  expected_goals_conceded numeric,
  minutes integer,
  goals_scored integer,
  assists integer,
  clean_sheets integer,
  goals_conceded integer,
  own_goals integer,
  penalties_saved integer,
  yellow_cards integer,
  red_cards integer,
  saves integer,
  bonus integer,
  bps integer,
  starts integer,
  influence_rank integer,
  influence_rank_type integer,
  creativity_rank integer,
  creativity_rank_type integer,
  threat_rank integer,
  threat_rank_type integer,
  ict_index_rank integer,
  ict_index_rank_type integer,
  transfers_in integer,
  transfers_in_event integer,
  transfers_out integer,
  transfers_out_event integer,
  selected_by_percent numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_event_snapshots_pkey PRIMARY KEY (season_id, event_id, element_id),
  CONSTRAINT player_event_snapshots_season_fk FOREIGN KEY (season_id)
    REFERENCES fpl.seasons(season_id),
  CONSTRAINT player_event_snapshots_ids_positive CHECK (
    event_id > 0 AND element_id > 0 AND source_snapshot_id > 0 AND element_type > 0
  ),
  CONSTRAINT player_event_snapshots_minutes_nonnegative CHECK (minutes IS NULL OR minutes >= 0),
  CONSTRAINT player_event_snapshots_selected_percent CHECK (
    selected_by_percent IS NULL OR selected_by_percent BETWEEN 0 AND 100
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS player_event_snapshots_source_id_idx
  ON fpl.player_event_snapshots (season_id, source_snapshot_id);
CREATE INDEX IF NOT EXISTS player_event_snapshots_player_idx
  ON fpl.player_event_snapshots (season_id, element_id, event_id);

CREATE TABLE IF NOT EXISTS fpl.player_gameweek_stats (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  element_id integer NOT NULL,
  source_live_id integer NOT NULL,
  minutes integer,
  goals_scored integer,
  assists integer,
  clean_sheets integer,
  goals_conceded integer,
  own_goals integer,
  penalties_saved integer,
  penalties_missed integer,
  yellow_cards integer,
  red_cards integer,
  saves integer,
  bonus integer,
  bps integer,
  starts boolean,
  expected_goals numeric,
  expected_assists numeric,
  expected_goal_involvements numeric,
  expected_goals_conceded numeric,
  in_dream_team boolean,
  total_points integer NOT NULL DEFAULT 0,
  defensive_contribution integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_gameweek_stats_pkey PRIMARY KEY (season_id, event_id, element_id),
  CONSTRAINT player_gameweek_stats_season_fk FOREIGN KEY (season_id)
    REFERENCES fpl.seasons(season_id),
  CONSTRAINT player_gameweek_stats_ids_positive CHECK (
    event_id > 0 AND element_id > 0 AND source_live_id > 0
  ),
  CONSTRAINT player_gameweek_stats_minutes_nonnegative CHECK (minutes IS NULL OR minutes >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS player_gameweek_stats_source_id_idx
  ON fpl.player_gameweek_stats (season_id, source_live_id);
CREATE INDEX IF NOT EXISTS player_gameweek_stats_player_idx
  ON fpl.player_gameweek_stats (season_id, element_id, event_id);

CREATE TABLE IF NOT EXISTS fpl.player_gameweek_scoring_items (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  element_id integer NOT NULL,
  scoring_identifier text NOT NULL,
  scoring_value integer NOT NULL,
  points integer NOT NULL,
  source_explain_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_gameweek_scoring_items_pkey
    PRIMARY KEY (season_id, event_id, element_id, scoring_identifier),
  CONSTRAINT player_gameweek_scoring_items_season_fk FOREIGN KEY (season_id)
    REFERENCES fpl.seasons(season_id),
  CONSTRAINT player_gameweek_scoring_items_ids_positive CHECK (
    event_id > 0 AND element_id > 0 AND source_explain_id > 0
  ),
  CONSTRAINT player_gameweek_scoring_items_identifier_valid CHECK (
    scoring_identifier IN (
      'minutes',
      'goals_scored',
      'assists',
      'clean_sheets',
      'goals_conceded',
      'own_goals',
      'penalties_saved',
      'penalties_missed',
      'yellow_cards',
      'red_cards',
      'saves',
      'bonus',
      'defensive_contribution'
    )
  )
);

CREATE INDEX IF NOT EXISTS player_gameweek_scoring_items_player_idx
  ON fpl.player_gameweek_scoring_items (season_id, element_id, event_id);
CREATE INDEX IF NOT EXISTS player_gameweek_scoring_items_source_id_idx
  ON fpl.player_gameweek_scoring_items (season_id, source_explain_id);

CREATE TABLE IF NOT EXISTS fpl.player_fixture_stats (
  season_id smallint NOT NULL,
  fixture_id integer NOT NULL,
  element_id integer NOT NULL,
  source_fixture_stat_id integer NOT NULL,
  event_id integer NOT NULL,
  fixture_code integer NOT NULL,
  player_code integer NOT NULL,
  team_id integer NOT NULL,
  team_code integer NOT NULL,
  element_type integer NOT NULL,
  minutes integer NOT NULL,
  starts integer,
  goals integer NOT NULL,
  assists integer NOT NULL,
  own_goals integer NOT NULL,
  yellow_cards integer NOT NULL,
  red_cards integer NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_fixture_stats_pkey PRIMARY KEY (season_id, fixture_id, element_id),
  CONSTRAINT player_fixture_stats_season_fk FOREIGN KEY (season_id)
    REFERENCES fpl.seasons(season_id),
  CONSTRAINT player_fixture_stats_ids_positive CHECK (
    fixture_id > 0
    AND element_id > 0
    AND source_fixture_stat_id > 0
    AND event_id > 0
    AND fixture_code > 0
    AND player_code > 0
    AND team_id > 0
    AND team_code > 0
    AND element_type > 0
  ),
  CONSTRAINT player_fixture_stats_counts_nonnegative CHECK (
    minutes >= 0
    AND (starts IS NULL OR starts >= 0)
    AND goals >= 0
    AND assists >= 0
    AND own_goals >= 0
    AND yellow_cards >= 0
    AND red_cards >= 0
  ),
  CONSTRAINT player_fixture_stats_source_hash_nonempty CHECK (btrim(source_hash) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS player_fixture_stats_source_id_idx
  ON fpl.player_fixture_stats (season_id, source_fixture_stat_id);
CREATE INDEX IF NOT EXISTS player_fixture_stats_event_idx
  ON fpl.player_fixture_stats (season_id, event_id);
CREATE INDEX IF NOT EXISTS player_fixture_stats_player_idx
  ON fpl.player_fixture_stats (season_id, element_id, event_id);
CREATE INDEX IF NOT EXISTS player_fixture_stats_team_idx
  ON fpl.player_fixture_stats (season_id, team_id);

CREATE TABLE IF NOT EXISTS fpl.player_market_snapshots (
  season_id smallint NOT NULL,
  snapshot_date date NOT NULL,
  element_id integer NOT NULL,
  source_snapshot_id integer,
  snapshot_source text NOT NULL DEFAULT 'upstream',
  source_value_id integer,
  source_event_id integer,
  captured_at timestamptz NOT NULL,
  player_code integer NOT NULL,
  web_name text NOT NULL,
  first_name text NOT NULL,
  second_name text NOT NULL,
  team_id integer NOT NULL,
  team_name text NOT NULL,
  team_short_name text NOT NULL,
  element_type integer NOT NULL,
  position text NOT NULL,
  price integer NOT NULL,
  selected_by_percent numeric NOT NULL,
  transfers_in integer NOT NULL,
  transfers_out integer NOT NULL,
  transfers_in_event integer NOT NULL,
  transfers_out_event integer NOT NULL,
  status text NOT NULL,
  news text NOT NULL,
  news_added timestamptz,
  chance_of_playing_this_round integer,
  chance_of_playing_next_round integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_market_snapshots_pkey PRIMARY KEY (season_id, snapshot_date, element_id),
  CONSTRAINT player_market_snapshots_season_fk FOREIGN KEY (season_id)
    REFERENCES fpl.seasons(season_id),
  CONSTRAINT player_market_snapshots_ids_positive CHECK (
    element_id > 0
    AND player_code > 0
    AND team_id > 0
    AND element_type > 0
    AND (source_snapshot_id IS NULL OR source_snapshot_id > 0)
    AND (source_value_id IS NULL OR source_value_id > 0)
    AND (source_event_id IS NULL OR source_event_id > 0)
  ),
  CONSTRAINT player_market_snapshots_source_valid CHECK (
    (
      snapshot_source = 'upstream'
      AND source_snapshot_id IS NOT NULL
      AND source_value_id IS NULL
    )
    OR
    (
      snapshot_source = 'legacy_value_seed'
      AND source_snapshot_id IS NULL
      AND source_value_id IS NOT NULL
      AND source_event_id IS NOT NULL
    )
  ),
  CONSTRAINT player_market_snapshots_price_nonnegative CHECK (price >= 0),
  CONSTRAINT player_market_snapshots_selected_percent CHECK (selected_by_percent BETWEEN 0 AND 100),
  CONSTRAINT player_market_snapshots_transfers_nonnegative CHECK (
    transfers_in >= 0
    AND transfers_out >= 0
    AND transfers_in_event >= 0
    AND transfers_out_event >= 0
  ),
  CONSTRAINT player_market_snapshots_chance_valid CHECK (
    (chance_of_playing_this_round IS NULL OR chance_of_playing_this_round BETWEEN 0 AND 100)
    AND (chance_of_playing_next_round IS NULL OR chance_of_playing_next_round BETWEEN 0 AND 100)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS player_market_snapshots_source_id_idx
  ON fpl.player_market_snapshots (season_id, source_snapshot_id)
  WHERE source_snapshot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS player_market_snapshots_source_value_idx
  ON fpl.player_market_snapshots (season_id, source_value_id)
  WHERE source_value_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS player_market_snapshots_player_idx
  ON fpl.player_market_snapshots (season_id, element_id, snapshot_date);
CREATE INDEX IF NOT EXISTS player_market_snapshots_team_idx
  ON fpl.player_market_snapshots (season_id, team_id, snapshot_date);

REVOKE ALL ON ALL TABLES IN SCHEMA fpl FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  fpl.fixtures,
  fpl.player_event_snapshots,
  fpl.player_gameweek_stats,
  fpl.player_gameweek_scoring_items,
  fpl.player_fixture_stats,
  fpl.player_market_snapshots
TO letletme_data_writer;

GRANT SELECT ON
  fpl.fixtures,
  fpl.player_event_snapshots,
  fpl.player_gameweek_stats,
  fpl.player_gameweek_scoring_items,
  fpl.player_fixture_stats,
  fpl.player_market_snapshots
TO letletme_graphql_reader;

RESET ROLE;
