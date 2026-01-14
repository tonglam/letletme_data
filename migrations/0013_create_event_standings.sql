CREATE TABLE IF NOT EXISTS "event_standings" (
    "id" SERIAL PRIMARY KEY,
    "event_id" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "team_id" INTEGER NOT NULL,
    "team_name" TEXT NOT NULL,
    "team_short_name" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "played" INTEGER NOT NULL,
    "won" INTEGER NOT NULL,
    "drawn" INTEGER NOT NULL,
    "lost" INTEGER NOT NULL,
    "goals_for" INTEGER NOT NULL,
    "goals_against" INTEGER NOT NULL,
    "goals_difference" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_event_standings_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    CONSTRAINT fk_event_standings_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "unique_event_standing" ON "event_standings" ("event_id", "team_id");
CREATE INDEX IF NOT EXISTS "idx_event_standings_event_id" ON "event_standings" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_event_standings_team_id" ON "event_standings" ("team_id");
