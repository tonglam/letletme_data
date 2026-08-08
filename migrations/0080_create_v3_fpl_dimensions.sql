-- Unified, unpartitioned FPL dimensions for every season.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL ROLE letletme_data_owner;

CREATE TABLE IF NOT EXISTS fpl.seasons (
  season_id smallint PRIMARY KEY,
  season_code text NOT NULL UNIQUE,
  display_name text NOT NULL UNIQUE,
  start_year smallint NOT NULL UNIQUE,
  end_year smallint NOT NULL UNIQUE,
  lifecycle_state text NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  starts_at date,
  ends_at date,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seasons_id_is_start_year CHECK (season_id = start_year),
  CONSTRAINT seasons_code_format CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT seasons_year_span CHECK (end_year = start_year + 1),
  CONSTRAINT seasons_lifecycle_state_valid CHECK (
    lifecycle_state IN ('reference_only', 'completed', 'preseason', 'active', 'closed')
  ),
  CONSTRAINT seasons_date_order CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CONSTRAINT seasons_source_metadata_object CHECK (jsonb_typeof(source_metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS seasons_one_current_idx
  ON fpl.seasons (is_current)
  WHERE is_current;

INSERT INTO fpl.seasons (
  season_id,
  season_code,
  display_name,
  start_year,
  end_year,
  lifecycle_state,
  is_current,
  source_metadata,
  created_at,
  updated_at
)
SELECT
  seed.season_id,
  seed.season_code,
  seed.display_name,
  seed.start_year,
  seed.end_year,
  seed.lifecycle_state,
  seed.is_current,
  seed.source_metadata,
  timestamptz '2026-08-08 16:00:08+00',
  timestamptz '2026-08-08 16:00:08+00'
FROM (VALUES
  (2011, '1112', '2011/12', 2011, 2012, 'reference_only', false, '{"scope":"competition_history_only"}'::jsonb),
  (2012, '1213', '2012/13', 2012, 2013, 'reference_only', false, '{"scope":"competition_history_only"}'::jsonb),
  (2013, '1314', '2013/14', 2013, 2014, 'reference_only', false, '{"scope":"competition_history_only"}'::jsonb),
  (2014, '1415', '2014/15', 2014, 2015, 'reference_only', false, '{"scope":"competition_history_only"}'::jsonb),
  (2015, '1516', '2015/16', 2015, 2016, 'reference_only', false, '{"scope":"competition_history_only"}'::jsonb),
  (2016, '1617', '2016/17', 2016, 2017, 'completed', false, '{"scope":"fpl_core_archive"}'::jsonb),
  (2017, '1718', '2017/18', 2017, 2018, 'completed', false, '{"scope":"fpl_core_archive"}'::jsonb),
  (2018, '1819', '2018/19', 2018, 2019, 'completed', false, '{"scope":"fpl_core_archive"}'::jsonb),
  (2019, '1920', '2019/20', 2019, 2020, 'completed', false, '{"scope":"fpl_core_archive"}'::jsonb),
  (2020, '2021', '2020/21', 2020, 2021, 'completed', false, '{"scope":"fpl_core_archive"}'::jsonb),
  (2021, '2122', '2021/22', 2021, 2022, 'completed', false, '{"scope":"fpl_core_archive"}'::jsonb),
  (2022, '2223', '2022/23', 2022, 2023, 'completed', false, '{"scope":"fpl_core_archive"}'::jsonb),
  (2023, '2324', '2023/24', 2023, 2024, 'completed', false, '{"scope":"fpl_core_archive"}'::jsonb),
  (2024, '2425', '2024/25', 2024, 2025, 'completed', false, '{"scope":"fpl_core_archive"}'::jsonb),
  (2025, '2526', '2025/26', 2025, 2026, 'completed', false, '{"scope":"fpl_core_archive"}'::jsonb),
  (2026, '2627', '2026/27', 2026, 2027, 'preseason', true, '{"scope":"fpl_current"}'::jsonb)
) AS seed(
  season_id,
  season_code,
  display_name,
  start_year,
  end_year,
  lifecycle_state,
  is_current,
  source_metadata
)
ON CONFLICT (season_id) DO NOTHING;

DO $season_authority$
BEGIN
  IF (SELECT count(*) FROM fpl.seasons WHERE is_current) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM fpl.seasons WHERE season_code = '2627' AND is_current
     ) THEN
    RAISE EXCEPTION 'v3 season authority must contain exactly one current season: 2627';
  END IF;
END
$season_authority$;

CREATE TABLE IF NOT EXISTS fpl.events (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  name text NOT NULL,
  deadline_time timestamptz,
  average_entry_score integer,
  finished boolean NOT NULL DEFAULT false,
  data_checked boolean NOT NULL DEFAULT false,
  highest_scoring_entry bigint,
  deadline_time_epoch bigint,
  deadline_time_game_offset integer,
  highest_score integer,
  is_previous boolean NOT NULL DEFAULT false,
  is_current boolean NOT NULL DEFAULT false,
  is_next boolean NOT NULL DEFAULT false,
  cup_league_create boolean NOT NULL DEFAULT false,
  h2h_ko_matches_created boolean NOT NULL DEFAULT false,
  chip_plays jsonb NOT NULL DEFAULT '[]'::jsonb,
  most_selected integer,
  most_transferred_in integer,
  top_element integer,
  top_element_info jsonb,
  transfers_made bigint,
  most_captained integer,
  most_vice_captained integer,
  live_snapshot_checked_at timestamptz,
  live_snapshot_finalized_at timestamptz,
  data_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_pkey PRIMARY KEY (season_id, event_id),
  CONSTRAINT events_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT events_event_id_positive CHECK (event_id > 0),
  CONSTRAINT events_scores_nonnegative CHECK (
    (average_entry_score IS NULL OR average_entry_score >= 0)
    AND (highest_score IS NULL OR highest_score >= 0)
  ),
  CONSTRAINT events_chip_plays_array CHECK (jsonb_typeof(chip_plays) = 'array'),
  CONSTRAINT events_finalization_order CHECK (
    live_snapshot_finalized_at IS NULL
    OR live_snapshot_checked_at IS NULL
    OR live_snapshot_finalized_at >= live_snapshot_checked_at
  )
);

CREATE INDEX IF NOT EXISTS events_deadline_idx
  ON fpl.events (season_id, deadline_time);
CREATE INDEX IF NOT EXISTS events_current_flags_idx
  ON fpl.events (season_id, is_current, is_next, is_previous);
CREATE INDEX IF NOT EXISTS events_top_element_idx
  ON fpl.events (season_id, top_element)
  WHERE top_element IS NOT NULL;

CREATE TABLE IF NOT EXISTS fpl.teams (
  season_id smallint NOT NULL,
  team_id integer NOT NULL,
  code integer NOT NULL,
  name text NOT NULL,
  short_name text NOT NULL,
  strength integer,
  position integer NOT NULL DEFAULT 0,
  points integer NOT NULL DEFAULT 0,
  win integer NOT NULL DEFAULT 0,
  draw integer NOT NULL DEFAULT 0,
  loss integer NOT NULL DEFAULT 0,
  played integer NOT NULL DEFAULT 0,
  form text,
  team_division integer,
  unavailable boolean NOT NULL DEFAULT false,
  strength_overall_home integer NOT NULL DEFAULT 1000,
  strength_overall_away integer NOT NULL DEFAULT 1000,
  strength_attack_home integer NOT NULL DEFAULT 1000,
  strength_attack_away integer NOT NULL DEFAULT 1000,
  strength_defence_home integer NOT NULL DEFAULT 1000,
  strength_defence_away integer NOT NULL DEFAULT 1000,
  pulse_id integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teams_pkey PRIMARY KEY (season_id, team_id),
  CONSTRAINT teams_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT teams_team_id_positive CHECK (team_id > 0),
  CONSTRAINT teams_code_positive CHECK (code > 0),
  CONSTRAINT teams_record_nonnegative CHECK (
    position >= 0 AND win >= 0 AND draw >= 0 AND loss >= 0 AND played >= 0
  ),
  CONSTRAINT teams_names_nonempty CHECK (btrim(name) <> '' AND btrim(short_name) <> ''),
  CONSTRAINT teams_season_code_unique UNIQUE (season_id, code)
);

CREATE INDEX IF NOT EXISTS teams_season_name_idx
  ON fpl.teams (season_id, name);

CREATE TABLE IF NOT EXISTS fpl.players (
  season_id smallint NOT NULL,
  element_id integer NOT NULL,
  code integer NOT NULL,
  element_type integer NOT NULL,
  team_id integer NOT NULL,
  price integer NOT NULL DEFAULT 0,
  start_price integer NOT NULL DEFAULT 0,
  first_name text,
  second_name text,
  web_name text NOT NULL,
  total_points integer NOT NULL DEFAULT 0,
  price_source_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT players_pkey PRIMARY KEY (season_id, element_id),
  CONSTRAINT players_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT players_element_id_positive CHECK (element_id > 0),
  CONSTRAINT players_code_positive CHECK (code > 0),
  CONSTRAINT players_element_type_positive CHECK (element_type > 0),
  CONSTRAINT players_prices_nonnegative CHECK (price >= 0 AND start_price >= 0),
  CONSTRAINT players_web_name_nonempty CHECK (btrim(web_name) <> ''),
  CONSTRAINT players_season_code_unique UNIQUE (season_id, code)
);

CREATE INDEX IF NOT EXISTS players_team_idx
  ON fpl.players (season_id, team_id);
CREATE INDEX IF NOT EXISTS players_type_idx
  ON fpl.players (season_id, element_type);
CREATE INDEX IF NOT EXISTS players_web_name_idx
  ON fpl.players (season_id, web_name);

CREATE TABLE IF NOT EXISTS fpl.phases (
  season_id smallint NOT NULL,
  phase_id integer NOT NULL,
  name text NOT NULL,
  start_event integer NOT NULL,
  stop_event integer NOT NULL,
  highest_score integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phases_pkey PRIMARY KEY (season_id, phase_id),
  CONSTRAINT phases_season_fk FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT phases_phase_id_positive CHECK (phase_id > 0),
  CONSTRAINT phases_event_range CHECK (
    start_event > 0 AND stop_event >= start_event
  ),
  CONSTRAINT phases_highest_score_nonnegative CHECK (highest_score IS NULL OR highest_score >= 0),
  CONSTRAINT phases_name_nonempty CHECK (btrim(name) <> '')
);

CREATE INDEX IF NOT EXISTS phases_event_range_idx
  ON fpl.phases (season_id, start_event, stop_event);

REVOKE ALL ON ALL TABLES IN SCHEMA fpl FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  fpl.seasons,
  fpl.events,
  fpl.teams,
  fpl.players,
  fpl.phases
TO letletme_data_writer;

GRANT SELECT ON
  fpl.seasons,
  fpl.events,
  fpl.teams,
  fpl.players,
  fpl.phases
TO letletme_graphql_reader;

RESET ROLE;
