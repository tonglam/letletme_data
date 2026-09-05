ALTER TABLE fpl.player_gameweek_stats
  ADD COLUMN IF NOT EXISTS publication_id text,
  ADD COLUMN IF NOT EXISTS publication_generation bigint,
  ADD COLUMN IF NOT EXISTS publication_event_live_sha256 text;

ALTER TABLE fpl.player_gameweek_stats
  DROP CONSTRAINT IF EXISTS player_gameweek_stats_publication_binding_all_or_none,
  DROP CONSTRAINT IF EXISTS player_gameweek_stats_publication_binding_valid;

ALTER TABLE fpl.player_gameweek_stats
  ADD CONSTRAINT player_gameweek_stats_publication_binding_all_or_none
    CHECK (
      (publication_id IS NULL AND publication_generation IS NULL AND publication_event_live_sha256 IS NULL)
      OR
      (publication_id IS NOT NULL AND publication_generation IS NOT NULL AND publication_event_live_sha256 IS NOT NULL)
    ),
  ADD CONSTRAINT player_gameweek_stats_publication_binding_valid
    CHECK (
      (publication_generation IS NULL OR publication_generation > 0)
      AND (publication_event_live_sha256 IS NULL OR publication_event_live_sha256 ~ '^[0-9a-f]{64}$')
    );

CREATE INDEX IF NOT EXISTS player_gameweek_stats_publication_binding_idx
  ON fpl.player_gameweek_stats (season_id, event_id, element_id, publication_generation)
  WHERE publication_id IS NOT NULL;
