DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chip') THEN
        CREATE TYPE "Chip" AS ENUM ('None', 'Wildcard', 'FreeHit', 'TripleCaptain', 'BenchBoost', 'Manager');
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'valuechangetype') THEN
        CREATE TYPE "ValueChangeType" AS ENUM ('Start', 'Rise', 'Fall');
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'leaguetype') THEN
        CREATE TYPE "LeagueType" AS ENUM ('Classic', 'H2H');
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cupresult') THEN
        CREATE TYPE "CupResult" AS ENUM ('Win', 'Loss');
    END IF;
END$$;

CREATE TABLE IF NOT EXISTS "events" (
    "id" INTEGER PRIMARY KEY,
    "name" TEXT NOT NULL,
    "deadline_time" TIMESTAMPTZ NOT NULL,
    "average_entry_score" INTEGER NOT NULL DEFAULT 0,
    "finished" BOOLEAN NOT NULL DEFAULT false,
    "data_checked" BOOLEAN NOT NULL DEFAULT false,
    "highest_score" INTEGER NOT NULL DEFAULT 0,
    "highest_scoring_entry" INTEGER NOT NULL DEFAULT 0,
    "is_previous" BOOLEAN NOT NULL DEFAULT false,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "is_next" BOOLEAN NOT NULL DEFAULT false,
    "cup_leagues_created" BOOLEAN NOT NULL DEFAULT false,
    "h2h_ko_matches_created" BOOLEAN NOT NULL DEFAULT false,
    "ranked_count" INTEGER NOT NULL DEFAULT 0,
    "chip_plays" JSONB,
    "most_selected" INTEGER,
    "most_transferred_in" INTEGER,
    "most_captained" INTEGER,
    "most_vice_captained" INTEGER,
    "top_element" INTEGER,
    "top_element_info" JSONB,
    "transfers_made" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "phases" (
    "id" INTEGER PRIMARY KEY,
    "name" TEXT NOT NULL,
    "start_event" INTEGER NOT NULL,
    "stop_event" INTEGER NOT NULL,
    "highest_score" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "phases" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "teams" (
    "id" INTEGER PRIMARY KEY,
    "code" INTEGER UNIQUE NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "strength" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 0,
    "win" INTEGER NOT NULL DEFAULT 0,
    "draw" INTEGER NOT NULL DEFAULT 0,
    "loss" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "players" (
    "id" INTEGER PRIMARY KEY,
    "code" INTEGER UNIQUE NOT NULL,
    "type" INTEGER NOT NULL,
    "team_id" INTEGER NOT NULL,
    "price" INTEGER NOT NULL DEFAULT 0,
    "start_price" INTEGER NOT NULL DEFAULT 0,
    "first_name" TEXT,
    "second_name" TEXT,
    "web_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "players" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "player_values" (
    "id" SERIAL PRIMARY KEY,
    "element_id" INTEGER NOT NULL,
    "element_type" INTEGER NOT NULL,
    "event_id" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    "change_date" CHAR(8) NOT NULL,
    "change_type" "ValueChangeType" NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_player_value" ON "player_values" ("element_id", "change_date");
CREATE INDEX IF NOT EXISTS "idx_player_values_element_id" ON "player_values" ("element_id");
CREATE INDEX IF NOT EXISTS "idx_player_values_change_date" ON "player_values" ("change_date");
ALTER TABLE "player_values" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "player_value_tracks" (
    "id" SERIAL PRIMARY KEY,
    "hour_index" INTEGER NOT NULL,
    "date" CHAR(8) NOT NULL,
    "event_id" INTEGER NOT NULL,
    "element_id" INTEGER NOT NULL,
    "element_type" INTEGER NOT NULL,
    "team_id" INTEGER NOT NULL,
    "chance_of_playing_this_round" INTEGER,
    "chance_of_playing_next_round" INTEGER,
    "transfers_in" INTEGER NOT NULL,
    "transfers_out" INTEGER NOT NULL,
    "transfers_in_event" INTEGER NOT NULL,
    "transfers_out_event" INTEGER NOT NULL,
    "selected_by" INTEGER NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_player_value_track" ON "player_value_tracks" ("element_id", "date", "hour_index");
CREATE INDEX IF NOT EXISTS "idx_player_value_track_date_hour_index" ON "player_value_tracks" ("date", "hour_index");
CREATE INDEX IF NOT EXISTS "idx_player_value_track_element_id" ON "player_value_tracks" ("element_id");
CREATE INDEX IF NOT EXISTS "idx_player_value_track_event_id" ON "player_value_tracks" ("event_id");
ALTER TABLE "player_value_tracks" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "player_stats" (
    "id" SERIAL PRIMARY KEY,
    "event_id" INTEGER NOT NULL,
    "element_id" INTEGER NOT NULL,
    "element_type" INTEGER NOT NULL,
    "form" FLOAT,
    "influence" FLOAT,
    "creativity" FLOAT,
    "threat" FLOAT,
    "ict_index" FLOAT,
    "expected_goals" DECIMAL(10,2),
    "expected_assists" DECIMAL(10,2),
    "expected_goal_involvements" DECIMAL(10,2),
    "expected_goals_conceded" DECIMAL(10,2),
    "minutes" INTEGER,
    "goals_scored" INTEGER,
    "assists" INTEGER,
    "clean_sheets" INTEGER,
    "goals_conceded" INTEGER,
    "own_goals" INTEGER,
    "penalties_saved" INTEGER,
    "total_points" INTEGER,
    "yellow_cards" INTEGER DEFAULT 0,
    "red_cards" INTEGER DEFAULT 0,
    "saves" INTEGER DEFAULT 0,
    "bonus" INTEGER DEFAULT 0,
    "bps" INTEGER DEFAULT 0,
    "starts" INTEGER DEFAULT 0,
    "influence_rank" INTEGER,
    "influence_rank_type" INTEGER,
    "creativity_rank" INTEGER,
    "creativity_rank_type" INTEGER,
    "threat_rank" INTEGER,
    "threat_rank_type" INTEGER,
    "ict_index_rank" INTEGER,
    "ict_index_rank_type" INTEGER,
    "mng_win" INTEGER,
    "mng_draw" INTEGER,
    "mng_loss" INTEGER,
    "mng_underdog_win" INTEGER,
    "mng_underdog_draw" INTEGER,
    "mng_clean_sheets" INTEGER,
    "mng_goals_scored" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_event_element" ON "player_stats" ("event_id", "element_id");
CREATE INDEX IF NOT EXISTS "idx_player_stats_element_id" ON "player_stats" ("element_id");
CREATE INDEX IF NOT EXISTS "idx_player_stats_event_id" ON "player_stats" ("event_id");
ALTER TABLE "player_stats" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "event_fixtures" (
    "id" SERIAL PRIMARY KEY,
    "code" INTEGER UNIQUE NOT NULL,
    "event" INTEGER NOT NULL,
    "kickoff_time" TIMESTAMPTZ,
    "started" BOOLEAN NOT NULL DEFAULT false,
    "finished" BOOLEAN NOT NULL DEFAULT false,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "team_h" INTEGER,
    "team_h_difficulty" INTEGER NOT NULL DEFAULT 0,
    "team_h_score" INTEGER NOT NULL DEFAULT 0,
    "team_a" INTEGER,
    "team_a_difficulty" INTEGER NOT NULL DEFAULT 0,
    "team_a_score" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_event_fixtures_event_id" ON "event_fixtures" ("event");
CREATE INDEX IF NOT EXISTS "idx_event_fixtures_team_h_id" ON "event_fixtures" ("team_h");
CREATE INDEX IF NOT EXISTS "idx_event_fixtures_team_a_id" ON "event_fixtures" ("team_a");
ALTER TABLE "event_fixtures" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "event_lives" (
    "id" SERIAL PRIMARY KEY,
    "event" INTEGER NOT NULL,
    "element" INTEGER NOT NULL,
    "minutes" INTEGER,
    "goals_scored" INTEGER,
    "assists" INTEGER,
    "clean_sheets" INTEGER,
    "goals_conceded" INTEGER,
    "own_goals" INTEGER,
    "penalties_saved" INTEGER,
    "penalties_missed" INTEGER,
    "yellow_cards" INTEGER,
    "red_cards" INTEGER,
    "saves" INTEGER,
    "bonus" INTEGER,
    "bps" INTEGER,
    "starts" BOOLEAN,
    "expected_goals" DECIMAL(10,2),
    "expected_assists" DECIMAL(10,2),
    "expected_goal_involvements" DECIMAL(10,2),
    "expected_goals_conceded" DECIMAL(10,2),
    "mng_win" INTEGER,
    "mng_draw" INTEGER,
    "mng_loss" INTEGER,
    "mng_underdog_win" INTEGER,
    "mng_underdog_draw" INTEGER,
    "mng_clean_sheets" INTEGER,
    "mng_goals_scored" INTEGER,
    "in_dream_team" BOOLEAN,
    "total_points" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_event_element_live" ON "event_lives" ("event", "element");
CREATE INDEX IF NOT EXISTS "idx_event_live_element_id" ON "event_lives" ("element");
CREATE INDEX IF NOT EXISTS "idx_event_live_event_id" ON "event_lives" ("event");
ALTER TABLE "event_lives" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "event_live_explains" (
    "id" SERIAL PRIMARY KEY,
    "event" INTEGER NOT NULL,
    "element" INTEGER NOT NULL,
    "bps" INTEGER,
    "bonus" INTEGER,
    "minutes" INTEGER,
    "minutes_points" INTEGER,
    "goals_scored" INTEGER,
    "goals_scored_points" INTEGER,
    "assists" INTEGER,
    "assists_points" INTEGER,
    "clean_sheets" INTEGER,
    "clean_sheets_points" INTEGER,
    "goals_conceded" INTEGER,
    "goals_conceded_points" INTEGER,
    "own_goals" INTEGER,
    "own_goals_points" INTEGER,
    "penalties_saved" INTEGER,
    "penalties_saved_points" INTEGER,
    "penalties_missed" INTEGER,
    "penalties_missed_points" INTEGER,
    "yellow_cards" INTEGER,
    "yellow_cards_points" INTEGER,
    "red_cards" INTEGER,
    "red_cards_points" INTEGER,
    "saves" INTEGER,
    "saves_points" INTEGER,
    "mng_win" INTEGER,
    "mng_win_points" INTEGER,
    "mng_draw" INTEGER,
    "mng_draw_points" INTEGER,
    "mng_loss" INTEGER,
    "mng_loss_points" INTEGER,
    "mng_underdog_win" INTEGER,
    "mng_underdog_win_points" INTEGER,
    "mng_underdog_draw" INTEGER,
    "mng_underdog_draw_points" INTEGER,
    "mng_clean_sheets" INTEGER,
    "mng_clean_sheets_points" INTEGER,
    "mng_goals_scored" INTEGER,
    "mng_goals_scored_points" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_event_element_live_explain" ON "event_live_explains" ("element", "event");
CREATE INDEX IF NOT EXISTS "idx_event_live_explain_element_id" ON "event_live_explains" ("element");
CREATE INDEX IF NOT EXISTS "idx_event_live_explain_event_id" ON "event_live_explains" ("event");
ALTER TABLE "event_live_explains" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "entry_infos" (
    "entry" INTEGER PRIMARY KEY,
    "entry_name" TEXT NOT NULL,
    "player_name" TEXT NOT NULL,
    "region" TEXT,
    "started_event" INTEGER NOT NULL DEFAULT 1,
    "overall_points" INTEGER NOT NULL DEFAULT 0,
    "overall_rank" INTEGER NOT NULL DEFAULT 0,
    "bank" INTEGER,
    "team_value" INTEGER,
    "total_transfers" INTEGER,
    "last_entry_name" TEXT,
    "last_overall_points" INTEGER,
    "last_overall_rank" INTEGER,
    "last_event_points" INTEGER,
    "last_team_value" INTEGER,
    "used_entry_names" TEXT[] NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "entry_infos" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "entry_league_infos" (
    "id" SERIAL PRIMARY KEY,
    "entry" INTEGER NOT NULL,
    "league_id" INTEGER NOT NULL,
    "league_name" TEXT NOT NULL,
    "league_type" "LeagueType" NOT NULL,
    "started_event" INTEGER,
    "entry_rank" INTEGER,
    "entry_last_rank" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_entry_league_info" ON "entry_league_infos" ("entry", "league_id");
CREATE INDEX IF NOT EXISTS "idx_entry_league_info_entry_id" ON "entry_league_infos" ("entry");
ALTER TABLE "entry_league_infos" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "entry_history_infos" (
    "id" SERIAL PRIMARY KEY,
    "entry" INTEGER NOT NULL,
    "season" INTEGER NOT NULL,
    "total_points" INTEGER NOT NULL DEFAULT 0,
    "overall_rank" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_entry_season_history" ON "entry_history_infos" ("entry", "season");
CREATE INDEX IF NOT EXISTS "idx_entry_history_info_entry_id" ON "entry_history_infos" ("entry");
ALTER TABLE "entry_history_infos" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "entry_event_picks" (
    "id" SERIAL PRIMARY KEY,
    "entry" INTEGER NOT NULL,
    "event" INTEGER NOT NULL,
    "chip" "Chip" NOT NULL,
    "picks" JSONB NOT NULL,
    "transfers" INTEGER NOT NULL DEFAULT 0,
    "transfers_cost" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_entry_event_pick" ON "entry_event_picks" ("entry", "event");
CREATE INDEX IF NOT EXISTS "idx_entry_event_picks_entry_id" ON "entry_event_picks" ("entry");
CREATE INDEX IF NOT EXISTS "idx_entry_event_picks_event_id" ON "entry_event_picks" ("event");
ALTER TABLE "entry_event_picks" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "entry_event_transfers" (
    "id" SERIAL PRIMARY KEY,
    "entry" INTEGER NOT NULL,
    "event" INTEGER NOT NULL,
    "element_in" INTEGER NOT NULL,
    "element_in_cost" INTEGER NOT NULL,
    "element_in_points" INTEGER NOT NULL DEFAULT 0,
    "element_out" INTEGER NOT NULL,
    "element_out_cost" INTEGER NOT NULL,
    "element_out_points" INTEGER NOT NULL DEFAULT 0,
    "transfer_time" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_entry_event_transfer" ON "entry_event_transfers" ("entry", "event");
CREATE INDEX IF NOT EXISTS "idx_entry_event_transfers_entry_id" ON "entry_event_transfers" ("entry");
ALTER TABLE "entry_event_transfers" ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "entry_event_results" (
    "id" SERIAL PRIMARY KEY,
    "entry" INTEGER NOT NULL,
    "event" INTEGER NOT NULL,
    "event_points" INTEGER NOT NULL DEFAULT 0,
    "event_transfers" INTEGER NOT NULL DEFAULT 0,
    "event_transfers_cost" INTEGER NOT NULL DEFAULT 0,
    "event_net_points" INTEGER NOT NULL DEFAULT 0,
    "event_bench_points" INTEGER,
    "event_auto_sub_points" INTEGER,
    "event_triple_captain_points" INTEGER,
    "event_rank" INTEGER,
    "event_chip" "Chip",
    "event_played_captain" INTEGER,
    "event_captain_points" INTEGER,
    "event_picks" JSONB,
    "event_auto_sub" JSONB,
    "overall_points" INTEGER NOT NULL DEFAULT 0,
    "overall_rank" INTEGER NOT NULL DEFAULT 0,
    "team_value" INTEGER,
    "bank" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_entry_event_result" ON "entry_event_results" ("entry", "event");
CREATE INDEX IF NOT EXISTS "idx_entry_event_results_entry_id" ON "entry_event_results" ("entry");
CREATE INDEX IF NOT EXISTS "idx_entry_event_results_event_id" ON "entry_event_results" ("event");
ALTER TABLE "entry_event_results" ENABLE ROW LEVEL SECURITY;
