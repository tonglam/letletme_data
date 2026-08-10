-- Provider-isolated Understat facts and evidence-backed provider links.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL ROLE letletme_data_owner;

DO $understat_bridge_enums$
BEGIN
  IF to_regtype('understat.lane') IS NULL THEN
    CREATE TYPE understat.lane AS ENUM ('team', 'player');
  END IF;
  IF to_regtype('understat.season_state') IS NULL THEN
    CREATE TYPE understat.season_state AS ENUM ('planned', 'active', 'complete');
  END IF;
  IF to_regtype('understat.sync_item_status') IS NULL THEN
    CREATE TYPE understat.sync_item_status AS ENUM ('pending', 'running', 'failed', 'completed', 'skipped');
  END IF;
  IF to_regtype('understat.sync_mode') IS NULL THEN
    CREATE TYPE understat.sync_mode AS ENUM ('incremental', 'full', 'reconcile');
  END IF;
  IF to_regtype('understat.sync_run_status') IS NULL THEN
    CREATE TYPE understat.sync_run_status AS ENUM (
      'pending', 'running', 'failed', 'completed', 'ready_to_publish', 'published'
    );
  END IF;
  IF to_regtype('understat.sync_trigger') IS NULL THEN
    CREATE TYPE understat.sync_trigger AS ENUM ('cron', 'manual', 'api');
  END IF;
  IF to_regtype('bridge.entity_type') IS NULL THEN
    CREATE TYPE bridge.entity_type AS ENUM ('team', 'player');
  END IF;
  IF to_regtype('bridge.link_status') IS NULL THEN
    CREATE TYPE bridge.link_status AS ENUM (
      'pending', 'auto_verified', 'manual_verified', 'ambiguous', 'quarantined', 'rejected'
    );
  END IF;
END
$understat_bridge_enums$;

CREATE TABLE IF NOT EXISTS understat.seasons (
  season_code text PRIMARY KEY,
  source_year integer NOT NULL UNIQUE,
  league text NOT NULL,
  state understat.season_state NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understat_seasons_code_format CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT understat_seasons_source_year_valid CHECK (source_year BETWEEN 2000 AND 2100),
  CONSTRAINT understat_seasons_league_nonempty CHECK (btrim(league) <> ''),
  CONSTRAINT understat_seasons_seen_order CHECK (last_seen_at >= first_seen_at)
);

CREATE TABLE IF NOT EXISTS understat.teams (
  team_id integer PRIMARY KEY,
  title text NOT NULL,
  short_title text,
  first_seen_season text NOT NULL,
  last_seen_season text NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understat_teams_id_positive CHECK (team_id > 0),
  CONSTRAINT understat_teams_title_nonempty CHECK (btrim(title) <> ''),
  CONSTRAINT understat_teams_season_format CHECK (
    first_seen_season ~ '^[0-9]{4}$' AND last_seen_season ~ '^[0-9]{4}$'
  ),
  CONSTRAINT understat_teams_season_order CHECK (last_seen_season >= first_seen_season),
  CONSTRAINT understat_teams_source_hash_nonempty CHECK (btrim(source_hash) <> '')
);

CREATE INDEX IF NOT EXISTS understat_teams_title_idx
  ON understat.teams (title);

CREATE TABLE IF NOT EXISTS understat.players (
  player_id integer PRIMARY KEY,
  name text NOT NULL,
  favorite_position text,
  first_seen_season text NOT NULL,
  last_seen_season text NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understat_players_id_positive CHECK (player_id > 0),
  CONSTRAINT understat_players_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT understat_players_season_format CHECK (
    first_seen_season ~ '^[0-9]{4}$' AND last_seen_season ~ '^[0-9]{4}$'
  ),
  CONSTRAINT understat_players_season_order CHECK (last_seen_season >= first_seen_season),
  CONSTRAINT understat_players_source_hash_nonempty CHECK (btrim(source_hash) <> '')
);

CREATE INDEX IF NOT EXISTS understat_players_name_idx
  ON understat.players (name);

CREATE TABLE IF NOT EXISTS understat.matches (
  match_id integer PRIMARY KEY,
  season_code text NOT NULL,
  home_team_id integer NOT NULL,
  away_team_id integer NOT NULL,
  kickoff_at timestamptz NOT NULL,
  is_result boolean NOT NULL DEFAULT false,
  home_goals integer,
  away_goals integer,
  home_xg numeric,
  away_xg numeric,
  forecast_home_win numeric,
  forecast_draw numeric,
  forecast_away_win numeric,
  source_hash text NOT NULL,
  source_checked_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understat_matches_id_positive CHECK (match_id > 0),
  CONSTRAINT understat_matches_season_format CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT understat_matches_distinct_teams CHECK (home_team_id <> away_team_id),
  CONSTRAINT understat_matches_goals_nonnegative CHECK (
    (home_goals IS NULL OR home_goals >= 0) AND (away_goals IS NULL OR away_goals >= 0)
  ),
  CONSTRAINT understat_matches_forecast_range CHECK (
    (forecast_home_win IS NULL OR forecast_home_win BETWEEN 0 AND 1)
    AND (forecast_draw IS NULL OR forecast_draw BETWEEN 0 AND 1)
    AND (forecast_away_win IS NULL OR forecast_away_win BETWEEN 0 AND 1)
  ),
  CONSTRAINT understat_matches_source_hash_nonempty CHECK (btrim(source_hash) <> ''),
  CONSTRAINT understat_matches_seen_order CHECK (last_seen_at >= source_checked_at)
);

CREATE INDEX IF NOT EXISTS understat_matches_season_kickoff_idx
  ON understat.matches (season_code, kickoff_at);
CREATE INDEX IF NOT EXISTS understat_matches_home_team_idx
  ON understat.matches (home_team_id, season_code, kickoff_at);
CREATE INDEX IF NOT EXISTS understat_matches_away_team_idx
  ON understat.matches (away_team_id, season_code, kickoff_at);

CREATE TABLE IF NOT EXISTS understat.team_match_stats (
  match_id integer NOT NULL,
  team_id integer NOT NULL,
  side text NOT NULL,
  xg numeric NOT NULL,
  xga numeric NOT NULL,
  npxg numeric NOT NULL,
  npxga numeric NOT NULL,
  npxgd numeric NOT NULL,
  ppda_att integer NOT NULL,
  ppda_def integer NOT NULL,
  ppda_allowed_att integer NOT NULL,
  ppda_allowed_def integer NOT NULL,
  deep integer NOT NULL,
  deep_allowed integer NOT NULL,
  scored integer NOT NULL,
  missed integer NOT NULL,
  xpoints numeric NOT NULL,
  result text NOT NULL,
  points integer NOT NULL,
  wins integer NOT NULL,
  draws integer NOT NULL,
  losses integer NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understat_team_match_stats_pkey PRIMARY KEY (match_id, team_id),
  CONSTRAINT understat_team_match_stats_side_valid CHECK (side IN ('h', 'a')),
  CONSTRAINT understat_team_match_stats_result_valid CHECK (result IN ('w', 'd', 'l')),
  CONSTRAINT understat_team_match_stats_counts_nonnegative CHECK (
    ppda_att >= 0 AND ppda_def >= 0 AND ppda_allowed_att >= 0 AND ppda_allowed_def >= 0
    AND deep >= 0 AND deep_allowed >= 0 AND scored >= 0 AND missed >= 0
    AND points >= 0 AND wins >= 0 AND draws >= 0 AND losses >= 0
  ),
  CONSTRAINT understat_team_match_stats_source_hash_nonempty CHECK (btrim(source_hash) <> '')
);

CREATE INDEX IF NOT EXISTS understat_team_match_stats_team_idx
  ON understat.team_match_stats (team_id, match_id);

CREATE TABLE IF NOT EXISTS understat.team_seasons (
  season_code text NOT NULL,
  team_id integer NOT NULL,
  source_title text NOT NULL,
  source_short_title text,
  games integer NOT NULL,
  wins integer NOT NULL,
  draws integer NOT NULL,
  losses integer NOT NULL,
  goals_for integer NOT NULL,
  goals_against integer NOT NULL,
  points integer NOT NULL,
  xg numeric NOT NULL,
  xga numeric NOT NULL,
  npxg numeric NOT NULL,
  npxga numeric NOT NULL,
  npxgd numeric NOT NULL,
  xpoints numeric NOT NULL,
  deep integer NOT NULL,
  deep_allowed integer NOT NULL,
  ppda_att integer NOT NULL,
  ppda_def integer NOT NULL,
  ppda_allowed_att integer NOT NULL,
  ppda_allowed_def integer NOT NULL,
  source_hash text NOT NULL,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understat_team_seasons_pkey PRIMARY KEY (season_code, team_id),
  CONSTRAINT understat_team_seasons_season_format CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT understat_team_seasons_counts_nonnegative CHECK (
    games >= 0 AND wins >= 0 AND draws >= 0 AND losses >= 0
    AND goals_for >= 0 AND goals_against >= 0 AND points >= 0
    AND deep >= 0 AND deep_allowed >= 0
    AND ppda_att >= 0 AND ppda_def >= 0 AND ppda_allowed_att >= 0 AND ppda_allowed_def >= 0
  ),
  CONSTRAINT understat_team_seasons_title_nonempty CHECK (btrim(source_title) <> ''),
  CONSTRAINT understat_team_seasons_source_hash_nonempty CHECK (btrim(source_hash) <> '')
);

CREATE INDEX IF NOT EXISTS understat_team_seasons_team_idx
  ON understat.team_seasons (team_id, season_code);

CREATE TABLE IF NOT EXISTS understat.team_stat_splits (
  season_code text NOT NULL,
  team_id integer NOT NULL,
  dimension text NOT NULL,
  split_key text NOT NULL,
  label text,
  time_minutes integer,
  shots_for integer NOT NULL,
  goals_for integer NOT NULL,
  xg_for numeric NOT NULL,
  shots_against integer NOT NULL,
  goals_against integer NOT NULL,
  xg_against numeric NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understat_team_stat_splits_pkey
    PRIMARY KEY (season_code, team_id, dimension, split_key),
  CONSTRAINT understat_team_stat_splits_season_format CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT understat_team_stat_splits_keys_nonempty CHECK (
    btrim(dimension) <> '' AND btrim(split_key) <> ''
  ),
  CONSTRAINT understat_team_stat_splits_counts_nonnegative CHECK (
    (time_minutes IS NULL OR time_minutes >= 0)
    AND shots_for >= 0 AND goals_for >= 0 AND shots_against >= 0 AND goals_against >= 0
  ),
  CONSTRAINT understat_team_stat_splits_source_hash_nonempty CHECK (btrim(source_hash) <> '')
);

CREATE INDEX IF NOT EXISTS understat_team_stat_splits_team_idx
  ON understat.team_stat_splits (team_id, season_code);

CREATE TABLE IF NOT EXISTS understat.player_seasons (
  season_code text NOT NULL,
  player_id integer NOT NULL,
  source_name text NOT NULL,
  source_team_title text NOT NULL,
  games integer NOT NULL,
  time_minutes integer NOT NULL,
  goals integer NOT NULL,
  non_penalty_goals integer NOT NULL,
  assists integer NOT NULL,
  shots integer NOT NULL,
  key_passes integer NOT NULL,
  yellow_cards integer NOT NULL,
  red_cards integer NOT NULL,
  xg numeric NOT NULL,
  non_penalty_xg numeric NOT NULL,
  xa numeric NOT NULL,
  xg_chain numeric NOT NULL,
  xg_buildup numeric NOT NULL,
  position text NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understat_player_seasons_pkey PRIMARY KEY (season_code, player_id),
  CONSTRAINT understat_player_seasons_season_format CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT understat_player_seasons_names_nonempty CHECK (
    btrim(source_name) <> '' AND btrim(source_team_title) <> '' AND btrim(position) <> ''
  ),
  CONSTRAINT understat_player_seasons_counts_nonnegative CHECK (
    games >= 0 AND time_minutes >= 0 AND goals >= 0 AND non_penalty_goals >= 0
    AND assists >= 0 AND shots >= 0 AND key_passes >= 0
    AND yellow_cards >= 0 AND red_cards >= 0
  ),
  CONSTRAINT understat_player_seasons_source_hash_nonempty CHECK (btrim(source_hash) <> '')
);

CREATE INDEX IF NOT EXISTS understat_player_seasons_player_idx
  ON understat.player_seasons (player_id, season_code);

CREATE TABLE IF NOT EXISTS understat.player_team_seasons (
  season_code text NOT NULL,
  player_id integer NOT NULL,
  team_id integer NOT NULL,
  games integer NOT NULL,
  time_minutes integer NOT NULL,
  goals integer NOT NULL,
  non_penalty_goals integer NOT NULL,
  assists integer NOT NULL,
  shots integer NOT NULL,
  key_passes integer NOT NULL,
  yellow_cards integer NOT NULL,
  red_cards integer NOT NULL,
  xg numeric NOT NULL,
  non_penalty_xg numeric NOT NULL,
  xa numeric NOT NULL,
  xg_chain numeric NOT NULL,
  xg_buildup numeric NOT NULL,
  position text NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understat_player_team_seasons_pkey PRIMARY KEY (season_code, player_id, team_id),
  CONSTRAINT understat_player_team_seasons_season_format CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT understat_player_team_seasons_counts_nonnegative CHECK (
    games >= 0 AND time_minutes >= 0 AND goals >= 0 AND non_penalty_goals >= 0
    AND assists >= 0 AND shots >= 0 AND key_passes >= 0
    AND yellow_cards >= 0 AND red_cards >= 0
  ),
  CONSTRAINT understat_player_team_seasons_position_nonempty CHECK (btrim(position) <> ''),
  CONSTRAINT understat_player_team_seasons_source_hash_nonempty CHECK (btrim(source_hash) <> '')
);

CREATE INDEX IF NOT EXISTS understat_player_team_seasons_team_idx
  ON understat.player_team_seasons (team_id, season_code);

CREATE TABLE IF NOT EXISTS understat.player_match_stats (
  roster_id integer PRIMARY KEY,
  match_id integer NOT NULL,
  player_id integer NOT NULL,
  team_id integer NOT NULL,
  player_name text NOT NULL,
  side text NOT NULL,
  position text NOT NULL,
  position_order integer NOT NULL,
  minutes integer NOT NULL,
  started boolean NOT NULL,
  goals integer NOT NULL,
  own_goals integer NOT NULL,
  shots integer NOT NULL,
  key_passes integer NOT NULL,
  assists integer NOT NULL,
  yellow_cards integer NOT NULL,
  red_cards integer NOT NULL,
  xg numeric NOT NULL,
  xa numeric NOT NULL,
  xg_chain numeric NOT NULL,
  xg_buildup numeric NOT NULL,
  roster_in_id integer,
  roster_out_id integer,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT understat_player_match_stats_ids_positive CHECK (
    roster_id > 0 AND match_id > 0 AND player_id > 0 AND team_id > 0
  ),
  CONSTRAINT understat_player_match_stats_side_valid CHECK (side IN ('h', 'a')),
  CONSTRAINT understat_player_match_stats_names_nonempty CHECK (
    btrim(player_name) <> '' AND btrim(position) <> ''
  ),
  CONSTRAINT understat_player_match_stats_counts_nonnegative CHECK (
    position_order >= 0 AND minutes >= 0 AND goals >= 0 AND own_goals >= 0
    AND shots >= 0 AND key_passes >= 0 AND assists >= 0
    AND yellow_cards >= 0 AND red_cards >= 0
  ),
  CONSTRAINT understat_player_match_stats_source_hash_nonempty CHECK (btrim(source_hash) <> '')
);

CREATE INDEX IF NOT EXISTS understat_player_match_stats_match_idx
  ON understat.player_match_stats (match_id, team_id, player_id);
CREATE INDEX IF NOT EXISTS understat_player_match_stats_player_idx
  ON understat.player_match_stats (player_id, match_id);
CREATE INDEX IF NOT EXISTS understat_player_match_stats_team_idx
  ON understat.player_match_stats (team_id, match_id);

CREATE TABLE IF NOT EXISTS bridge.entity_links (
  link_id uuid PRIMARY KEY,
  entity_type bridge.entity_type NOT NULL,
  left_provider text NOT NULL,
  left_entity_id text,
  right_provider text NOT NULL,
  right_entity_id text NOT NULL,
  status bridge.link_status NOT NULL,
  method text NOT NULL,
  rule_version text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_season text,
  last_seen_season text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bridge_entity_links_distinct_providers CHECK (left_provider <> right_provider),
  CONSTRAINT bridge_entity_links_fields_nonempty CHECK (
    btrim(left_provider) <> '' AND btrim(right_provider) <> ''
    AND btrim(right_entity_id) <> '' AND btrim(method) <> '' AND btrim(rule_version) <> ''
  ),
  CONSTRAINT bridge_entity_links_verified_complete CHECK (
    status NOT IN ('auto_verified', 'manual_verified')
    OR (left_entity_id IS NOT NULL AND btrim(left_entity_id) <> '')
  ),
  CONSTRAINT bridge_entity_links_evidence_object CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT bridge_entity_links_season_order CHECK (
    last_seen_season IS NULL OR first_seen_season IS NULL OR last_seen_season >= first_seen_season
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS bridge_entity_links_verified_left_idx
  ON bridge.entity_links (entity_type, left_provider, left_entity_id)
  WHERE status IN ('auto_verified', 'manual_verified');
CREATE UNIQUE INDEX IF NOT EXISTS bridge_entity_links_verified_right_idx
  ON bridge.entity_links (entity_type, right_provider, right_entity_id)
  WHERE status IN ('auto_verified', 'manual_verified');
CREATE INDEX IF NOT EXISTS bridge_entity_links_status_idx
  ON bridge.entity_links (entity_type, status, last_seen_season);

CREATE TABLE IF NOT EXISTS bridge.match_links (
  link_id uuid PRIMARY KEY,
  season_code text NOT NULL,
  left_provider text NOT NULL,
  left_match_id text NOT NULL,
  right_provider text NOT NULL,
  right_match_id text NOT NULL,
  status bridge.link_status NOT NULL,
  method text NOT NULL,
  rule_version text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bridge_match_links_season_format CHECK (season_code ~ '^[0-9]{4}$'),
  CONSTRAINT bridge_match_links_distinct_providers CHECK (left_provider <> right_provider),
  CONSTRAINT bridge_match_links_fields_nonempty CHECK (
    btrim(left_provider) <> '' AND btrim(left_match_id) <> ''
    AND btrim(right_provider) <> '' AND btrim(right_match_id) <> ''
    AND btrim(method) <> '' AND btrim(rule_version) <> ''
  ),
  CONSTRAINT bridge_match_links_evidence_object CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT bridge_match_links_pair_unique
    UNIQUE (season_code, left_provider, left_match_id, right_provider, right_match_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS bridge_match_links_verified_left_idx
  ON bridge.match_links (season_code, left_provider, left_match_id)
  WHERE status IN ('auto_verified', 'manual_verified');
CREATE UNIQUE INDEX IF NOT EXISTS bridge_match_links_verified_right_idx
  ON bridge.match_links (season_code, right_provider, right_match_id)
  WHERE status IN ('auto_verified', 'manual_verified');
CREATE INDEX IF NOT EXISTS bridge_match_links_status_idx
  ON bridge.match_links (season_code, status);

CREATE TABLE IF NOT EXISTS bridge.entity_aliases (
  alias_id uuid PRIMARY KEY,
  entity_type bridge.entity_type NOT NULL,
  provider text NOT NULL,
  provider_entity_id text NOT NULL,
  alias text NOT NULL,
  source text NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bridge_entity_aliases_fields_nonempty CHECK (
    btrim(provider) <> '' AND btrim(provider_entity_id) <> ''
    AND btrim(alias) <> '' AND btrim(source) <> ''
  ),
  CONSTRAINT bridge_entity_aliases_observed_order CHECK (last_observed_at >= first_observed_at),
  CONSTRAINT bridge_entity_aliases_business_unique
    UNIQUE (entity_type, provider, provider_entity_id, alias, source)
);

CREATE INDEX IF NOT EXISTS bridge_entity_aliases_lookup_idx
  ON bridge.entity_aliases (entity_type, provider, alias);

REVOKE ALL ON ALL TABLES IN SCHEMA understat, bridge FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA understat
TO letletme_data_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA bridge
TO letletme_data_writer;

GRANT SELECT ON
  understat.seasons,
  understat.teams,
  understat.players,
  understat.matches,
  understat.team_match_stats,
  understat.team_seasons,
  understat.team_stat_splits,
  understat.player_seasons,
  understat.player_team_seasons,
  understat.player_match_stats,
  bridge.entity_links,
  bridge.match_links,
  bridge.entity_aliases
TO letletme_graphql_reader;

RESET ROLE;
