-- V2 lifecycle checkpoints identify the Redis publication by generation. The
-- old text live_revision field is a retired V1 name and is not read by V2.
ALTER TABLE ops.live_lifecycle_status
  RENAME COLUMN live_revision TO generation;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ops.live_lifecycle_status
    WHERE generation IS NOT NULL
      AND btrim(generation) <> ''
      AND btrim(generation) !~ '^[0-9]+$'
  ) THEN
    RAISE EXCEPTION
      'live_lifecycle_status contains non-numeric V1 revisions; repair the rows before the V2 hard cut';
  END IF;
END $$;

ALTER TABLE ops.live_lifecycle_status
  ALTER COLUMN generation TYPE bigint
  USING NULLIF(btrim(generation), '')::bigint;

ALTER TABLE ops.live_lifecycle_status
  ADD CONSTRAINT live_lifecycle_status_generation_valid
  CHECK (generation IS NULL OR generation > 0);
