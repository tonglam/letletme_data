CREATE TABLE IF NOT EXISTS "league_event_results" (
    "id" SERIAL PRIMARY KEY,
    "league_id" INTEGER NOT NULL,
    "league_type" "league_type" NOT NULL,
    "event_id" INTEGER NOT NULL,
    "entry_id" INTEGER NOT NULL,
    "entry_name" TEXT,
    "player_name" TEXT,
    "overall_points" INTEGER NOT NULL DEFAULT 0,
    "overall_rank" INTEGER NOT NULL DEFAULT 0,
    "team_value" INTEGER,
    "bank" INTEGER,
    "event_points" INTEGER NOT NULL DEFAULT 0,
    "event_transfers" INTEGER NOT NULL DEFAULT 0,
    "event_transfers_cost" INTEGER NOT NULL DEFAULT 0,
    "event_net_points" INTEGER NOT NULL DEFAULT 0,
    "event_bench_points" INTEGER,
    "event_auto_sub_points" INTEGER,
    "event_rank" INTEGER,
    "event_chip" "chip",
    "captain_id" INTEGER,
    "captain_points" INTEGER,
    "captain_blank" BOOLEAN,
    "vice_captain_id" INTEGER,
    "vice_captain_points" INTEGER,
    "vice_captain_blank" BOOLEAN,
    "played_captain_id" INTEGER,
    "highest_score_element_id" INTEGER,
    "highest_score_points" INTEGER,
    "highest_score_blank" BOOLEAN,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_league_event_results_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    CONSTRAINT fk_league_event_results_entry FOREIGN KEY (entry_id) REFERENCES entry_infos(id) ON DELETE CASCADE,
    CONSTRAINT fk_league_event_results_captain FOREIGN KEY (captain_id) REFERENCES players(id) ON DELETE SET NULL,
    CONSTRAINT fk_league_event_results_vice_captain FOREIGN KEY (vice_captain_id) REFERENCES players(id) ON DELETE SET NULL,
    CONSTRAINT fk_league_event_results_played_captain FOREIGN KEY (played_captain_id) REFERENCES players(id) ON DELETE SET NULL,
    CONSTRAINT fk_league_event_results_highest_score FOREIGN KEY (highest_score_element_id) REFERENCES players(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "unique_league_event_result" ON "league_event_results" ("league_id", "league_type", "event_id", "entry_id");
CREATE INDEX IF NOT EXISTS "idx_league_event_results_league_id" ON "league_event_results" ("league_id");
CREATE INDEX IF NOT EXISTS "idx_league_event_results_event_id" ON "league_event_results" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_league_event_results_entry_id" ON "league_event_results" ("entry_id");
