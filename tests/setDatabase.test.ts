import { prisma } from '../src';

const createEventsTable = async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "events" (
      "id" INTEGER NOT NULL,
      "name" TEXT NOT NULL,
      "deadline_time" TIMESTAMPTZ NOT NULL,
      "deadline_time_epoch" INTEGER NOT NULL,
      "deadline_time_game_offset" INTEGER NOT NULL,
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
      "chip_plays" JSONB DEFAULT NULL,
      "most_selected" INTEGER,
      "most_transferred_in" INTEGER,
      "most_captained" INTEGER,
      "most_vice_captained" INTEGER,
      "top_element" INTEGER,
      "top_element_info" JSONB DEFAULT NULL,
      "transfers_made" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "events_pkey" PRIMARY KEY ("id")
    )
  `;

  await prisma.$executeRaw`ALTER TABLE "events" ENABLE ROW LEVEL SECURITY`;
  await prisma.$executeRaw`CREATE POLICY "Enable read access for all users" ON "events" FOR SELECT USING (true)`;
  await prisma.$executeRaw`CREATE POLICY "Enable write access for service role" ON "events" FOR ALL TO service_role USING (true)`;
};

const createPhasesTable = async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "phases" (
      "id" INTEGER NOT NULL,
      "name" TEXT NOT NULL,
      "start_event" INTEGER NOT NULL,
      "stop_event" INTEGER NOT NULL,
      "highest_score" INTEGER,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "phases_pkey" PRIMARY KEY ("id")
    )
  `;

  await prisma.$executeRaw`ALTER TABLE "phases" ENABLE ROW LEVEL SECURITY`;
  await prisma.$executeRaw`CREATE POLICY "Enable read access for all users" ON "phases" FOR SELECT USING (true)`;
  await prisma.$executeRaw`CREATE POLICY "Enable write access for service role" ON "phases" FOR ALL TO service_role USING (true)`;
};

const createTeamsTable = async () => {
  await prisma.$executeRaw`DROP TABLE IF EXISTS "teams" CASCADE`;
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "teams" (
      "id" INTEGER NOT NULL,
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
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
    )
  `;

  await prisma.$executeRaw`ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY`;
  await prisma.$executeRaw`CREATE POLICY "Enable read access for all users" ON "teams" FOR SELECT USING (true)`;
  await prisma.$executeRaw`CREATE POLICY "Enable write access for service role" ON "teams" FOR ALL TO service_role USING (true)`;
};

const createPlayersTable = async () => {
  await prisma.$executeRaw`DROP TABLE IF EXISTS "players" CASCADE`;
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "players" (
      "element" INTEGER NOT NULL,
      "element_code" INTEGER NOT NULL,
      "price" INTEGER NOT NULL,
      "start_price" INTEGER NOT NULL,
      "element_type" INTEGER NOT NULL,
      "first_name" TEXT,
      "second_name" TEXT,
      "web_name" TEXT NOT NULL,
      "team_id" INTEGER NOT NULL,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "players_pkey" PRIMARY KEY ("element"),
      CONSTRAINT "players_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams" ("id") ON DELETE CASCADE
    )
  `;

  await prisma.$executeRaw`ALTER TABLE "players" ENABLE ROW LEVEL SECURITY`;
  await prisma.$executeRaw`CREATE POLICY "Enable read access for all users" ON "players" FOR SELECT USING (true)`;
  await prisma.$executeRaw`CREATE POLICY "Enable write access for service role" ON "players" FOR ALL TO service_role USING (true)`;
};

const createPlayerStatsTable = async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "player_stats" (
      "id" TEXT NOT NULL,
      "event_id" INTEGER NOT NULL,
      "element_id" INTEGER NOT NULL,
      "team_id" INTEGER NOT NULL,
      "form" DOUBLE PRECISION,
      "influence" DOUBLE PRECISION,
      "creativity" DOUBLE PRECISION,
      "threat" DOUBLE PRECISION,
      "ict_index" DOUBLE PRECISION,
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
      CONSTRAINT "player_stats_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "unique_event_element" UNIQUE ("event_id", "element_id"),
      CONSTRAINT "player_stats_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events" ("id") ON DELETE CASCADE,
      CONSTRAINT "player_stats_element_id_fkey" FOREIGN KEY ("element_id") REFERENCES "players" ("element_id") ON DELETE CASCADE,
      CONSTRAINT "player_stats_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams" ("team_id") ON DELETE CASCADE
    )
  `;

  await prisma.$executeRaw`ALTER TABLE "player_stats" ENABLE ROW LEVEL SECURITY`;
  await prisma.$executeRaw`CREATE POLICY "Enable read access for all users" ON "player_stats" FOR SELECT USING (true)`;
  await prisma.$executeRaw`CREATE POLICY "Enable write access for service role" ON "player_stats" FOR ALL TO service_role USING (true)`;
};

const createPlayerValuesTable = async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "player_values" (
      "id" TEXT NOT NULL,
      "event_id" INTEGER NOT NULL,
      "element_id" INTEGER NOT NULL,
      "value" INTEGER NOT NULL,
      "change_type" TEXT NOT NULL,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "player_values_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "player_values_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events" ("id") ON DELETE CASCADE,
      CONSTRAINT "player_values_element_id_fkey" FOREIGN KEY ("element_id") REFERENCES "players" ("element_id") ON DELETE CASCADE
    )
  `;

  await prisma.$executeRaw`ALTER TABLE "player_values" ENABLE ROW LEVEL SECURITY`;
  await prisma.$executeRaw`CREATE POLICY "Enable read access for all users" ON "player_values" FOR SELECT USING (true)`;
  await prisma.$executeRaw`CREATE POLICY "Enable write access for service role" ON "player_values" FOR ALL TO service_role USING (true)`;
};

const createEventFixturesTable = async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "event_fixtures" (
      "id" TEXT NOT NULL,
      "event_id" INTEGER NOT NULL,
      "team_h_id" INTEGER NOT NULL,
      "team_a_id" INTEGER NOT NULL,
      "team_h_score" INTEGER,
      "team_a_score" INTEGER,
      "team_h_difficulty" INTEGER NOT NULL,
      "team_a_difficulty" INTEGER NOT NULL,
      "kickoff_time" TIMESTAMPTZ,
      "finished" BOOLEAN NOT NULL DEFAULT false,
      "started" BOOLEAN NOT NULL DEFAULT false,
      "provisional_start_time" BOOLEAN NOT NULL DEFAULT false,
      "minutes" INTEGER,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "event_fixtures_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "event_fixtures_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events" ("id") ON DELETE CASCADE,
      CONSTRAINT "event_fixtures_team_h_id_fkey" FOREIGN KEY ("team_h_id") REFERENCES "teams" ("team_id") ON DELETE CASCADE,
      CONSTRAINT "event_fixtures_team_a_id_fkey" FOREIGN KEY ("team_a_id") REFERENCES "teams" ("team_id") ON DELETE CASCADE
    )
  `;

  await prisma.$executeRaw`ALTER TABLE "event_fixtures" ENABLE ROW LEVEL SECURITY`;
  await prisma.$executeRaw`CREATE POLICY "Enable read access for all users" ON "event_fixtures" FOR SELECT USING (true)`;
  await prisma.$executeRaw`CREATE POLICY "Enable write access for service role" ON "event_fixtures" FOR ALL TO service_role USING (true)`;
};

const createEntriesTable = async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "entries" (
      "id" TEXT NOT NULL,
      "entry_id" INTEGER NOT NULL UNIQUE,
      "joined_time" TEXT,
      "started_event" INTEGER,
      "favourite_team" INTEGER,
      "player_first_name" TEXT,
      "player_last_name" TEXT,
      "player_region_id" INTEGER,
      "player_region_name" TEXT,
      "player_region_iso_code_short" TEXT,
      "player_region_iso_code_long" TEXT,
      "name" TEXT NOT NULL,
      "name_change_blocked" BOOLEAN NOT NULL DEFAULT false,
      "league_type" TEXT,
      "league_scoring" TEXT,
      "league_rank" INTEGER,
      "league_rank_count" INTEGER,
      "league_entry_rank" INTEGER,
      "league_entry_last_rank" INTEGER,
      "league_entry_percentile_rank" INTEGER,
      "summary_overall_points" INTEGER,
      "summary_overall_rank" INTEGER,
      "summary_event_points" INTEGER,
      "summary_event_rank" INTEGER,
      "current_event" INTEGER,
      "last_deadline_bank" INTEGER,
      "last_deadline_value" INTEGER,
      "last_deadline_total_transfers" INTEGER,
      "entered_events" INTEGER[],
      "kit" JSONB,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ NOT NULL,
      CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
    )
  `;

  await prisma.$executeRaw`ALTER TABLE "entries" ENABLE ROW LEVEL SECURITY`;
  await prisma.$executeRaw`CREATE POLICY "Enable read access for all users" ON "entries" FOR SELECT USING (true)`;
  await prisma.$executeRaw`CREATE POLICY "Enable write access for service role" ON "entries" FOR ALL TO service_role USING (true)`;
};

const createEntryEventPicksTable = async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "entry_event_picks" (
      "id" TEXT NOT NULL,
      "entry_id" INTEGER NOT NULL,
      "event_id" INTEGER NOT NULL,
      "picks" JSONB NOT NULL,
      "active_chip" TEXT,
      "automatic_subs" JSONB,
      "points" INTEGER NOT NULL DEFAULT 0,
      "points_on_bench" INTEGER NOT NULL DEFAULT 0,
      "bank" INTEGER NOT NULL DEFAULT 0,
      "value" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ NOT NULL,
      CONSTRAINT "entry_event_picks_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "unique_entry_event_pick" UNIQUE ("entry_id", "event_id"),
      CONSTRAINT "entry_event_picks_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries" ("entry_id") ON DELETE CASCADE,
      CONSTRAINT "entry_event_picks_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events" ("id") ON DELETE CASCADE
    )
  `;

  await prisma.$executeRaw`ALTER TABLE "entry_event_picks" ENABLE ROW LEVEL SECURITY`;
  await prisma.$executeRaw`CREATE POLICY "Enable read access for all users" ON "entry_event_picks" FOR SELECT USING (true)`;
  await prisma.$executeRaw`CREATE POLICY "Enable write access for service role" ON "entry_event_picks" FOR ALL TO service_role USING (true)`;
};

const createEntryEventTransfersTable = async () => {
  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS "entry_event_transfers" (
      "id" TEXT NOT NULL,
      "entry_id" INTEGER NOT NULL,
      "event_id" INTEGER NOT NULL,
      "transfers" JSONB NOT NULL,
      "cost" INTEGER NOT NULL DEFAULT 0,
      "status" TEXT NOT NULL DEFAULT 'confirmed',
      "limit" INTEGER NOT NULL DEFAULT 1,
      "made" INTEGER NOT NULL DEFAULT 0,
      "bank" INTEGER NOT NULL DEFAULT 0,
      "value" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ NOT NULL,
      CONSTRAINT "entry_event_transfers_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "unique_entry_event_transfer" UNIQUE ("entry_id", "event_id"),
      CONSTRAINT "entry_event_transfers_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries" ("entry_id") ON DELETE CASCADE,
      CONSTRAINT "entry_event_transfers_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events" ("id") ON DELETE CASCADE
    )
  `;
};

export {
  createEntriesTable,
  createEntryEventPicksTable,
  createEntryEventTransfersTable,
  createEventFixturesTable,
  createEventsTable,
  createPhasesTable,
  createPlayersTable,
  createPlayerStatsTable,
  createPlayerValuesTable,
  createTeamsTable,
};
