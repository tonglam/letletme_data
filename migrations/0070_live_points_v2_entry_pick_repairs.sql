-- Existing entry picks are source data, not a proof that a complete V2 input
-- exists.  The hard cut records invalid scopes separately so the seed step can
-- repair them explicitly without creating a synthetic head or publishing an
-- incomplete squad.
CREATE TABLE IF NOT EXISTS competition.entry_event_pick_repairs (
  season_id smallint NOT NULL,
  entry_id integer NOT NULL,
  event_id integer NOT NULL,
  reason text NOT NULL,
  observed_row_count integer NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'PENDING',
  last_attempt_at timestamptz,
  resolved_at timestamptz,
  CONSTRAINT entry_event_pick_repairs_pkey PRIMARY KEY (season_id, entry_id, event_id),
  CONSTRAINT entry_event_pick_repairs_entry_fk
    FOREIGN KEY (season_id, entry_id)
    REFERENCES competition.entries (season_id, entry_id),
  CONSTRAINT entry_event_pick_repairs_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events (season_id, event_id),
  CONSTRAINT entry_event_pick_repairs_scope_valid CHECK (
    season_id > 0 AND entry_id > 0 AND event_id > 0
  ),
  CONSTRAINT entry_event_pick_repairs_reason_valid CHECK (btrim(reason) <> ''),
  CONSTRAINT entry_event_pick_repairs_row_count_valid CHECK (observed_row_count >= 0),
  CONSTRAINT entry_event_pick_repairs_status_valid CHECK (
    status = ANY (ARRAY['PENDING', 'REPAIRED', 'IGNORED']::text[])
  ),
  CONSTRAINT entry_event_pick_repairs_resolution_valid CHECK (
    (status = 'PENDING' AND resolved_at IS NULL)
    OR (status IN ('REPAIRED', 'IGNORED') AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS entry_event_pick_repairs_pending_idx
  ON competition.entry_event_pick_repairs (season_id, event_id, observed_at)
  WHERE status = 'PENDING';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE competition.entry_event_pick_repairs TO letletme_data_writer;
