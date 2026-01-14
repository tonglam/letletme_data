CREATE TABLE IF NOT EXISTS "entry_event_cup_results" (
    "id" SERIAL PRIMARY KEY,
    "event_id" INTEGER NOT NULL,
    "entry_id" INTEGER NOT NULL,
    "entry_name" TEXT,
    "player_name" TEXT,
    "event_points" INTEGER,
    "against_entry_id" INTEGER,
    "against_entry_name" TEXT,
    "against_player_name" TEXT,
    "against_event_points" INTEGER,
    "result" "cup_result",
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_entry_event_cup_results_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    CONSTRAINT fk_entry_event_cup_results_entry FOREIGN KEY (entry_id) REFERENCES entry_infos(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "unique_entry_event_cup_result" ON "entry_event_cup_results" ("entry_id", "event_id");
CREATE INDEX IF NOT EXISTS "idx_entry_event_cup_results_event_id" ON "entry_event_cup_results" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_entry_event_cup_results_entry_id" ON "entry_event_cup_results" ("entry_id");
