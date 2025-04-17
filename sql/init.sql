-- Custom types
CREATE TYPE "ValueChangeType" AS ENUM ('Start', 'Rise', 'Fall');

-- Events table
CREATE TABLE "events" (
    "id" INTEGER PRIMARY KEY,
    "name" TEXT NOT NULL,
    "deadline_time" TEXT NOT NULL,
    "deadline_time_epoch" INTEGER NOT NULL DEFAULT 0,
    "deadline_time_game_offset" INTEGER NOT NULL DEFAULT 0,
    "release_time" TEXT,
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

-- Phases table
CREATE TABLE "phases" (
    "id" INTEGER PRIMARY KEY,
    "name" TEXT NOT NULL,
    "start_event" INTEGER NOT NULL,
    "stop_event" INTEGER NOT NULL,
    "highest_score" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "phases" ENABLE ROW LEVEL SECURITY;

-- Teams table
CREATE TABLE "teams" (
    "id" INTEGER PRIMARY KEY,
    "code" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "strength" INTEGER NOT NULL,
    "strength_overall_home" INTEGER NOT NULL,
    "strength_overall_away" INTEGER NOT NULL,
    "strength_attack_home" INTEGER NOT NULL,
    "strength_attack_away" INTEGER NOT NULL,
    "strength_defence_home" INTEGER NOT NULL,
    "strength_defence_away" INTEGER NOT NULL,
    "pulse_id" INTEGER NOT NULL,
    "played" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 0,
    "form" TEXT,
    "win" INTEGER NOT NULL DEFAULT 0,
    "draw" INTEGER NOT NULL DEFAULT 0,
    "loss" INTEGER NOT NULL DEFAULT 0,
    "team_division" TEXT,
    "unavailable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;

-- Players table
CREATE TABLE "players" (
    "element" INTEGER PRIMARY KEY,
    "element_code" INTEGER UNIQUE NOT NULL,
    "price" INTEGER NOT NULL DEFAULT 0,
    "start_price" INTEGER NOT NULL DEFAULT 0,
    "element_type" INTEGER NOT NULL,
    "first_name" TEXT,
    "second_name" TEXT,
    "web_name" TEXT NOT NULL,
    "team_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "players" ENABLE ROW LEVEL SECURITY;

-- Player Values table
CREATE TABLE "player_values" (
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
CREATE UNIQUE INDEX "unique_player_value" ON "player_values" ("element_id", "change_date");
CREATE INDEX "idx_player_values_element_id" ON "player_values" ("element_id");
CREATE INDEX "idx_player_values_change_date" ON "player_values" ("change_date");
CREATE INDEX "idx_player_values_element_type" ON "player_values" ("element_type");
ALTER TABLE "player_values" ENABLE ROW LEVEL SECURITY;

-- Player Stats table
CREATE TABLE "player_stats" (
    "id" SERIAL PRIMARY KEY,
    "event_id" INTEGER NOT NULL,
    "element_id" INTEGER NOT NULL,
    "team_id" INTEGER NOT NULL,
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
    "expected_goals_per_90" DECIMAL(10,2),
    "saves_per_90" DECIMAL(10,2),
    "expected_assists_per_90" DECIMAL(10,2),
    "expected_goal_involvements_per_90" DECIMAL(10,2),
    "expected_goals_conceded_per_90" DECIMAL(10,2),
    "goals_conceded_per_90" DECIMAL(10,2),
    "starts_per_90" DECIMAL(10,2),
    "clean_sheets_per_90" DECIMAL(10,2),
    "corners_and_indirect_freekicks_order" INTEGER,
    "corners_and_indirect_freekicks_text" TEXT,
    "direct_freekicks_order" INTEGER,
    "direct_freekicks_text" TEXT,
    "penalties_order" INTEGER,
    "penalties_text" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "unique_event_element" ON "player_stats" ("event_id", "element_id");
CREATE INDEX "idx_player_stats_element_id" ON "player_stats" ("element_id");
CREATE INDEX "idx_player_stats_team_id" ON "player_stats" ("team_id");
CREATE INDEX "idx_player_stats_event_id" ON "player_stats" ("event_id");
ALTER TABLE "player_stats" ENABLE ROW LEVEL SECURITY;

-- Event Fixtures table
CREATE TABLE "event_fixtures" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "code" INTEGER NOT NULL,
    "event" INTEGER NOT NULL,
    "kickoff_time" TIMESTAMPTZ,
    "started" BOOLEAN NOT NULL DEFAULT false,
    "finished" BOOLEAN NOT NULL DEFAULT false,
    "provisional_start_time" BOOLEAN NOT NULL DEFAULT false,
    "finished_provisional" BOOLEAN NOT NULL DEFAULT false,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "team_h" INTEGER,
    "team_h_difficulty" INTEGER NOT NULL DEFAULT 0,
    "team_h_score" INTEGER NOT NULL DEFAULT 0,
    "team_a" INTEGER,
    "team_a_difficulty" INTEGER NOT NULL DEFAULT 0,
    "team_a_score" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "idx_home" ON "event_fixtures" ("event", "team_h");
CREATE INDEX "idx_away" ON "event_fixtures" ("event", "team_a");
ALTER TABLE "event_fixtures" ENABLE ROW LEVEL SECURITY;
