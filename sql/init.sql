-- Create custom types
CREATE TYPE "PlayerValueChangeType" AS ENUM ('Start', 'Rise', 'Fall');

-- Create tables
CREATE TABLE "events" (
    "id" INTEGER PRIMARY KEY,
    "name" TEXT NOT NULL,
    "deadline_time" TIMESTAMPTZ NOT NULL,
    "deadline_time_epoch" INTEGER NOT NULL DEFAULT 0,
    "deadline_time_game_offset" INTEGER NOT NULL DEFAULT 0,
    "release_time" TIMESTAMPTZ,
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

CREATE TABLE "phases" (
    "id" INTEGER PRIMARY KEY,
    "name" TEXT NOT NULL,
    "start_event" INTEGER NOT NULL,
    "stop_event" INTEGER NOT NULL,
    "highest_score" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE "players" (
    "element" INTEGER PRIMARY KEY,
    "element_code" INTEGER UNIQUE NOT NULL,
    "price" INTEGER NOT NULL DEFAULT 0,
    "start_price" INTEGER NOT NULL DEFAULT 0,
    "element_type" INTEGER NOT NULL,
    "first_name" TEXT,
    "second_name" TEXT,
    "web_name" TEXT NOT NULL,
    "team_id" INTEGER NOT NULL REFERENCES "teams" ("id") ON DELETE CASCADE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "player_values" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "element_id" INTEGER NOT NULL REFERENCES "players" ("element") ON DELETE CASCADE,
    "element_type" INTEGER NOT NULL,
    "event_id" INTEGER NOT NULL REFERENCES "events" ("id") ON DELETE CASCADE,
    "value" INTEGER NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,
    "change_date" TEXT NOT NULL,
    "change_type" "PlayerValueChangeType" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX "idx_players_team_id" ON "players" ("team_id");
CREATE INDEX "idx_player_values_element_id" ON "player_values" ("element_id");
CREATE INDEX "idx_player_values_change_date" ON "player_values" ("change_date");

-- Enable Row Level Security
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "phases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "players" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "player_values" ENABLE ROW LEVEL SECURITY;
