-- Replace periodic My FPL scope audits with a transaction-local generation
-- signal.  The scope table is intentionally small: it records that a
-- terminal event needs verification, while the finalization worker remains
-- the only place that reads and rebuilds canonical scope data.
SET LOCAL statement_timeout = '30s';

CREATE TABLE competition.my_fpl_snapshot_scope_state (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  entry_scope_generation bigint NOT NULL DEFAULT 0,
  verified_entry_scope_generation bigint NOT NULL DEFAULT 0,
  tournament_scope_generation bigint NOT NULL DEFAULT 0,
  verified_tournament_scope_generation bigint NOT NULL DEFAULT 0,
  entry_dirty_since timestamptz,
  tournament_dirty_since timestamptz,
  verified_revision bigint,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT my_fpl_snapshot_scope_state_pkey PRIMARY KEY (season_id, event_id),
  CONSTRAINT my_fpl_snapshot_scope_state_season_fk
    FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id),
  CONSTRAINT my_fpl_snapshot_scope_state_event_fk
    FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)
      ON DELETE CASCADE,
  CONSTRAINT my_fpl_snapshot_scope_state_entry_generation_check
    CHECK (entry_scope_generation >= 0 AND verified_entry_scope_generation >= 0
      AND verified_entry_scope_generation <= entry_scope_generation),
  CONSTRAINT my_fpl_snapshot_scope_state_tournament_generation_check
    CHECK (tournament_scope_generation >= 0 AND verified_tournament_scope_generation >= 0
      AND verified_tournament_scope_generation <= tournament_scope_generation),
  CONSTRAINT my_fpl_snapshot_scope_state_revision_check
    CHECK (verified_revision IS NULL OR verified_revision > 0),
  CONSTRAINT my_fpl_snapshot_scope_state_revision_fk
    FOREIGN KEY (season_id, event_id, verified_revision)
    REFERENCES competition.my_fpl_snapshot_publications(season_id, event_id, revision)
    ON DELETE CASCADE
);

CREATE INDEX my_fpl_snapshot_scope_state_dirty_idx
  ON competition.my_fpl_snapshot_scope_state(season_id, event_id, updated_at)
  WHERE entry_scope_generation > verified_entry_scope_generation
     OR tournament_scope_generation > verified_tournament_scope_generation;

CREATE INDEX my_fpl_snapshot_scope_state_revision_idx
  ON competition.my_fpl_snapshot_scope_state(season_id, event_id, verified_revision)
  WHERE verified_revision IS NOT NULL;

COMMENT ON TABLE competition.my_fpl_snapshot_scope_state IS
  'Short transaction-local scope generations for terminal My FPL publication capture.';
COMMENT ON COLUMN competition.my_fpl_snapshot_scope_state.entry_scope_generation IS
  'Desired generation after an INSERT/DELETE/key or started_event mutation in competition.entries.';
COMMENT ON COLUMN competition.my_fpl_snapshot_scope_state.tournament_scope_generation IS
  'Desired generation after tournament membership or tournament key/count mutation.';

GRANT SELECT, INSERT, UPDATE ON competition.my_fpl_snapshot_scope_state TO letletme_data_writer;
GRANT SELECT ON competition.my_fpl_snapshot_scope_state TO letletme_graphql_reader;

-- Keep terminal rows available when an event crosses the data_checked fence.
-- This only touches the state table and never inspects canonical scope rows.
CREATE OR REPLACE FUNCTION competition.ensure_my_fpl_snapshot_scope_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  was_terminal boolean;
  is_terminal boolean;
BEGIN
  is_terminal := COALESCE(NEW.finished, false) AND COALESCE(NEW.data_checked, false);
  IF TG_OP = 'UPDATE' THEN
    was_terminal := COALESCE(OLD.finished, false) AND COALESCE(OLD.data_checked, false);
  ELSE
    was_terminal := false;
  END IF;

  -- A first terminal INSERT needs a state row.  A transition in either
  -- direction establishes a new finalization fence and must invalidate any
  -- previously verified publication before the next terminal capture.
  IF is_terminal OR was_terminal THEN
    INSERT INTO competition.my_fpl_snapshot_scope_state (season_id, event_id)
    VALUES (NEW.season_id, NEW.event_id)
    ON CONFLICT (season_id, event_id) DO NOTHING;
  END IF;

  IF TG_OP = 'UPDATE' AND was_terminal IS DISTINCT FROM is_terminal THEN
    UPDATE competition.my_fpl_snapshot_scope_state
    SET entry_scope_generation = entry_scope_generation + 1,
        tournament_scope_generation = tournament_scope_generation + 1,
        entry_dirty_since = COALESCE(entry_dirty_since, clock_timestamp()),
        tournament_dirty_since = COALESCE(tournament_dirty_since, clock_timestamp()),
        verified_revision = NULL,
        verified_at = NULL,
        updated_at = clock_timestamp()
    WHERE season_id = NEW.season_id
      AND event_id = NEW.event_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER my_fpl_snapshot_scope_state_event_ready
AFTER INSERT OR UPDATE OF finished, data_checked ON fpl.events
FOR EACH ROW
EXECUTE FUNCTION competition.ensure_my_fpl_snapshot_scope_state();

-- Bump only existing terminal event rows, in stable season/event order. The
-- helper receives distinct seasons from a statement-level transition table,
-- so one bulk write increments each family at most once per season/event.
CREATE OR REPLACE FUNCTION competition.bump_my_fpl_snapshot_scope_generation(
  p_scope text,
  p_season_ids smallint[]
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  affected record;
BEGIN
  IF p_scope NOT IN ('entry', 'tournament') THEN
    RAISE EXCEPTION 'unsupported My FPL scope family: %', p_scope;
  END IF;

  FOR affected IN
    SELECT event.season_id, event.event_id
    FROM fpl.events event
    WHERE event.season_id = ANY(COALESCE(p_season_ids, ARRAY[]::smallint[]))
      AND event.finished
      AND event.data_checked
    ORDER BY event.season_id, event.event_id
  LOOP
    INSERT INTO competition.my_fpl_snapshot_scope_state (season_id, event_id)
    VALUES (affected.season_id, affected.event_id)
    ON CONFLICT (season_id, event_id) DO NOTHING;

    IF p_scope = 'entry' THEN
      UPDATE competition.my_fpl_snapshot_scope_state
      SET entry_scope_generation = entry_scope_generation + 1,
          entry_dirty_since = COALESCE(entry_dirty_since, clock_timestamp()),
          updated_at = clock_timestamp()
      WHERE season_id = affected.season_id AND event_id = affected.event_id;
    ELSE
      UPDATE competition.my_fpl_snapshot_scope_state
      SET tournament_scope_generation = tournament_scope_generation + 1,
          tournament_dirty_since = COALESCE(tournament_dirty_since, clock_timestamp()),
          updated_at = clock_timestamp()
      WHERE season_id = affected.season_id AND event_id = affected.event_id;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION competition.bump_my_fpl_entry_scope_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  seasons smallint[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT season_id), ARRAY[]::smallint[])
    INTO seasons
  FROM new_rows;
  PERFORM competition.bump_my_fpl_snapshot_scope_generation('entry', seasons);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION competition.bump_my_fpl_entry_scope_on_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  seasons smallint[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT season_id), ARRAY[]::smallint[])
    INTO seasons
  FROM old_rows;
  PERFORM competition.bump_my_fpl_snapshot_scope_generation('entry', seasons);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION competition.bump_my_fpl_entry_scope_on_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  seasons smallint[];
BEGIN
  WITH changed AS (
    SELECT COALESCE(new_row.season_id, old_row.season_id)::smallint AS season_id
    FROM old_rows old_row
    FULL JOIN new_rows new_row
      ON new_row.season_id = old_row.season_id
     AND new_row.entry_id = old_row.entry_id
    WHERE new_row.entry_id IS NULL
       OR old_row.entry_id IS NULL
       OR new_row.started_event IS DISTINCT FROM old_row.started_event
  )
  SELECT COALESCE(array_agg(DISTINCT season_id), ARRAY[]::smallint[])
    INTO seasons
  FROM changed;
  PERFORM competition.bump_my_fpl_snapshot_scope_generation('entry', seasons);
  RETURN NULL;
END;
$$;

CREATE TRIGGER my_fpl_snapshot_scope_entries_insert
AFTER INSERT ON competition.entries
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION competition.bump_my_fpl_entry_scope_on_insert();

CREATE TRIGGER my_fpl_snapshot_scope_entries_delete
AFTER DELETE ON competition.entries
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION competition.bump_my_fpl_entry_scope_on_delete();

CREATE TRIGGER my_fpl_snapshot_scope_entries_update
AFTER UPDATE ON competition.entries
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION competition.bump_my_fpl_entry_scope_on_update();

CREATE OR REPLACE FUNCTION competition.bump_my_fpl_tournament_scope_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  seasons smallint[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT season_id), ARRAY[]::smallint[])
    INTO seasons
  FROM new_rows;
  PERFORM competition.bump_my_fpl_snapshot_scope_generation('tournament', seasons);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION competition.bump_my_fpl_tournament_scope_on_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  seasons smallint[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT season_id), ARRAY[]::smallint[])
    INTO seasons
  FROM old_rows;
  PERFORM competition.bump_my_fpl_snapshot_scope_generation('tournament', seasons);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION competition.bump_my_fpl_tournament_scope_on_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  seasons smallint[];
BEGIN
  WITH changed AS (
    SELECT COALESCE(new_row.season_id, old_row.season_id)::smallint AS season_id
    FROM old_rows old_row
    FULL JOIN new_rows new_row
      ON new_row.season_id = old_row.season_id
     AND new_row.tournament_id = old_row.tournament_id
     AND new_row.entry_id = old_row.entry_id
    WHERE new_row.entry_id IS NULL
       OR old_row.entry_id IS NULL
  )
  SELECT COALESCE(array_agg(DISTINCT season_id), ARRAY[]::smallint[])
    INTO seasons
  FROM changed;
  PERFORM competition.bump_my_fpl_snapshot_scope_generation('tournament', seasons);
  RETURN NULL;
END;
$$;

CREATE TRIGGER my_fpl_snapshot_scope_tournament_entries_insert
AFTER INSERT ON competition.tournament_entries
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION competition.bump_my_fpl_tournament_scope_on_insert();

CREATE TRIGGER my_fpl_snapshot_scope_tournament_entries_delete
AFTER DELETE ON competition.tournament_entries
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION competition.bump_my_fpl_tournament_scope_on_delete();

CREATE TRIGGER my_fpl_snapshot_scope_tournament_entries_update
AFTER UPDATE ON competition.tournament_entries
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION competition.bump_my_fpl_tournament_scope_on_update();

CREATE OR REPLACE FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  seasons smallint[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT season_id), ARRAY[]::smallint[])
    INTO seasons
  FROM new_rows;
  PERFORM competition.bump_my_fpl_snapshot_scope_generation('tournament', seasons);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  seasons smallint[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT season_id), ARRAY[]::smallint[])
    INTO seasons
  FROM old_rows;
  PERFORM competition.bump_my_fpl_snapshot_scope_generation('tournament', seasons);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  seasons smallint[];
BEGIN
  WITH changed AS (
    SELECT COALESCE(new_row.season_id, old_row.season_id)::smallint AS season_id
    FROM old_rows old_row
    FULL JOIN new_rows new_row
      ON new_row.season_id = old_row.season_id
     AND new_row.tournament_id = old_row.tournament_id
    WHERE new_row.tournament_id IS NULL
       OR old_row.tournament_id IS NULL
  )
  SELECT COALESCE(array_agg(DISTINCT season_id), ARRAY[]::smallint[])
    INTO seasons
  FROM changed;
  PERFORM competition.bump_my_fpl_snapshot_scope_generation('tournament', seasons);
  RETURN NULL;
END;
$$;

CREATE TRIGGER my_fpl_snapshot_scope_tournaments_insert
AFTER INSERT ON competition.tournaments
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_insert();

CREATE TRIGGER my_fpl_snapshot_scope_tournaments_delete
AFTER DELETE ON competition.tournaments
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_delete();

CREATE TRIGGER my_fpl_snapshot_scope_tournaments_update
AFTER UPDATE ON competition.tournaments
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_update();

-- Initialize state from the old, bounded-by-the-migration status view before
-- replacing it.  ON CONFLICT DO NOTHING is intentional: a trigger that saw a
-- concurrent mutation owns a newer dirty state and must not be overwritten by
-- this one-time baseline.
INSERT INTO competition.my_fpl_snapshot_scope_state (
  season_id,
  event_id,
  entry_scope_generation,
  verified_entry_scope_generation,
  tournament_scope_generation,
  verified_tournament_scope_generation,
  entry_dirty_since,
  tournament_dirty_since,
  verified_revision,
  verified_at,
  updated_at
)
SELECT status.season_id,
       status.event_id,
       CASE WHEN status.kind = 'FINAL' THEN 1 ELSE 0 END,
       CASE
         WHEN status.kind = 'FINAL'
          AND status.expected_entry_count IS NOT NULL
          AND status.observed_entry_count = status.expected_entry_count
          AND status.expected_entry_scope_sha256 IS NOT NULL
          AND status.expected_entry_scope_sha256 = status.observed_entry_scope_sha256
          AND status.not_applicable_entry_count = status.expected_not_applicable_entry_count
         THEN 1 ELSE 0
       END,
       CASE WHEN status.kind = 'FINAL' THEN 1 ELSE 0 END,
       CASE
         WHEN status.kind = 'FINAL'
          AND status.expected_tournament_count IS NOT NULL
          AND status.observed_tournament_count = status.expected_tournament_count
          AND status.expected_tournament_scope_sha256 IS NOT NULL
          AND status.expected_tournament_scope_sha256 = status.observed_tournament_scope_sha256
         THEN 1 ELSE 0
       END,
       CASE
         WHEN status.kind = 'FINAL'
          AND NOT (
            status.expected_entry_count IS NOT NULL
            AND status.observed_entry_count = status.expected_entry_count
            AND status.expected_entry_scope_sha256 IS NOT NULL
            AND status.expected_entry_scope_sha256 = status.observed_entry_scope_sha256
            AND status.not_applicable_entry_count = status.expected_not_applicable_entry_count
          )
         THEN clock_timestamp()
       END,
       CASE
         WHEN status.kind = 'FINAL'
          AND NOT (
            status.expected_tournament_count IS NOT NULL
            AND status.observed_tournament_count = status.expected_tournament_count
            AND status.expected_tournament_scope_sha256 IS NOT NULL
            AND status.expected_tournament_scope_sha256 = status.observed_tournament_scope_sha256
          )
         THEN clock_timestamp()
       END,
       CASE
         WHEN status.kind = 'FINAL'
          AND status.revision IS NOT NULL
          AND status.expected_entry_count IS NOT NULL
          AND status.observed_entry_count = status.expected_entry_count
          AND status.expected_entry_scope_sha256 IS NOT NULL
          AND status.expected_entry_scope_sha256 = status.observed_entry_scope_sha256
          AND status.not_applicable_entry_count = status.expected_not_applicable_entry_count
          AND status.expected_tournament_count IS NOT NULL
          AND status.observed_tournament_count = status.expected_tournament_count
          AND status.expected_tournament_scope_sha256 IS NOT NULL
          AND status.expected_tournament_scope_sha256 = status.observed_tournament_scope_sha256
         THEN status.revision
       END,
       CASE
         WHEN status.kind = 'FINAL'
          AND status.revision IS NOT NULL
          AND status.expected_entry_count IS NOT NULL
          AND status.observed_entry_count = status.expected_entry_count
          AND status.expected_entry_scope_sha256 IS NOT NULL
          AND status.expected_entry_scope_sha256 = status.observed_entry_scope_sha256
          AND status.not_applicable_entry_count = status.expected_not_applicable_entry_count
          AND status.expected_tournament_count IS NOT NULL
          AND status.observed_tournament_count = status.expected_tournament_count
          AND status.expected_tournament_scope_sha256 IS NOT NULL
          AND status.expected_tournament_scope_sha256 = status.observed_tournament_scope_sha256
         THEN clock_timestamp()
       END,
       clock_timestamp()
FROM reporting.my_fpl_active_snapshot_status status
JOIN fpl.events event
  ON event.season_id = status.season_id AND event.event_id = status.event_id
WHERE event.finished AND event.data_checked
ON CONFLICT (season_id, event_id) DO NOTHING;

-- Keep the public reporting shape unchanged, but make it a projection over
-- event/publication/state only. A dirty FINAL intentionally has no visible
-- revision or expected/hash evidence, so GraphQL's existing inner join fails
-- closed instead of serving a stale active revision.
CREATE OR REPLACE VIEW reporting.my_fpl_active_snapshot_status
WITH (security_invoker = true) AS
WITH active AS (
  SELECT publication.season_id,
         publication.event_id,
         publication.revision,
         publication.snapshot_date,
         publication.kind,
         publication.source_checked_at,
         publication.published_at,
         publication.expected_entry_count,
         publication.ready_entry_count,
         publication.empty_entry_count,
         publication.not_applicable_entry_count,
         publication.expected_tournament_count,
         publication.ready_tournament_count,
         publication.entry_scope_sha256,
         publication.tournament_scope_sha256
  FROM competition.my_fpl_snapshot_publications publication
  WHERE publication.active
), shaped AS (
  SELECT event.season_id,
         event.event_id,
         event.finished,
         event.data_checked,
         event.data_checked_at,
         active.revision,
         active.snapshot_date,
         active.kind,
         active.source_checked_at,
         active.published_at,
         active.expected_entry_count,
         active.ready_entry_count,
         active.empty_entry_count,
         active.not_applicable_entry_count,
         active.expected_tournament_count,
         active.ready_tournament_count,
         active.entry_scope_sha256,
         active.tournament_scope_sha256,
         state.entry_scope_generation = state.verified_entry_scope_generation
           AND state.tournament_scope_generation = state.verified_tournament_scope_generation
           AND state.verified_revision = active.revision
           AND event.finished
           AND event.data_checked
           AND active.kind = 'FINAL'
           AND active.entry_scope_sha256 IS NOT NULL
           AND active.tournament_scope_sha256 IS NOT NULL AS final_verified
  FROM fpl.events event
  LEFT JOIN active
    ON active.season_id = event.season_id AND active.event_id = event.event_id
  LEFT JOIN competition.my_fpl_snapshot_scope_state state
    ON state.season_id = event.season_id AND state.event_id = event.event_id
)
SELECT shaped.season_id,
       shaped.event_id,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.revision END AS revision,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.snapshot_date END AS snapshot_date,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.kind END AS kind,
       shaped.finished,
       shaped.data_checked,
       shaped.data_checked_at,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.source_checked_at END AS source_checked_at,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.published_at END AS published_at,
       CASE WHEN shaped.data_checked_at IS NULL THEN NULL ELSE shaped.data_checked_at END
         AS finalization_started_at,
       CASE WHEN shaped.data_checked_at IS NULL THEN NULL
            ELSE shaped.data_checked_at + interval '4500 seconds' END
         AS finalization_due_at,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.expected_entry_count END AS expected_entry_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.ready_entry_count + shaped.empty_entry_count END
         AS observed_entry_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.not_applicable_entry_count END AS not_applicable_entry_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.not_applicable_entry_count END AS expected_not_applicable_entry_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN GREATEST(shaped.expected_entry_count - shaped.ready_entry_count - shaped.empty_entry_count, 0)
         END AS pending_correction_entry_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.expected_tournament_count END AS expected_tournament_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.ready_tournament_count END AS observed_tournament_count,
       CASE
         WHEN shaped.kind IS NULL THEN 'NO_PUBLICATION'
         WHEN shaped.final_verified THEN 'COMPLETE'
         WHEN shaped.kind = 'PROVISIONAL'
          AND shaped.ready_entry_count + shaped.empty_entry_count = shaped.expected_entry_count
          AND shaped.ready_tournament_count = shaped.expected_tournament_count
           THEN 'COMPLETE'
         ELSE 'CORRECTION_PENDING'
       END AS coverage_state,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.entry_scope_sha256 END AS expected_entry_scope_sha256,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.tournament_scope_sha256 END AS expected_tournament_scope_sha256,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.entry_scope_sha256 END AS observed_entry_scope_sha256,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.tournament_scope_sha256 END AS observed_tournament_scope_sha256
FROM shaped;

GRANT SELECT ON reporting.my_fpl_active_snapshot_status TO letletme_graphql_reader;
GRANT SELECT ON reporting.my_fpl_active_snapshot_status TO letletme_data_writer;

COMMENT ON VIEW reporting.my_fpl_active_snapshot_status IS
  'Data-owned active My FPL revision backed by transaction-local scope generations.';
