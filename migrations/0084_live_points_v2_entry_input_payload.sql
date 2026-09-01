ALTER TABLE competition.entry_event_pick_heads
  ADD COLUMN IF NOT EXISTS input_payload jsonb;

ALTER TABLE competition.entry_event_pick_heads
  DROP CONSTRAINT IF EXISTS entry_event_pick_heads_input_payload_valid;

ALTER TABLE competition.entry_event_pick_heads
  ADD CONSTRAINT entry_event_pick_heads_input_payload_valid CHECK (
    input_payload IS NULL
    OR (
      jsonb_typeof(input_payload) = 'object'
      AND pg_column_size(input_payload) <= 131072
    )
  );

COMMENT ON COLUMN competition.entry_event_pick_heads.input_payload IS
  'Complete V2 entry input captured at checkpoint time; null heads are not eligible for lossless final recovery.';
