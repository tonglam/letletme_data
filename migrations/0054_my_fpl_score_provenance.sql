-- Keep My FPL publication provenance separate from the source span. New
-- captures populate source_checked_at conservatively as the minimum.

ALTER TABLE competition.my_fpl_snapshot_publications
  ADD COLUMN IF NOT EXISTS score_source text,
  ADD COLUMN IF NOT EXISTS live_publication_id uuid,
  ADD COLUMN IF NOT EXISTS live_revision text,
  ADD COLUMN IF NOT EXISTS algorithm_version text,
  ADD COLUMN IF NOT EXISTS source_min_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_max_checked_at timestamptz;

ALTER TABLE competition.my_fpl_snapshot_publications
  DROP CONSTRAINT IF EXISTS my_fpl_snapshot_publications_score_source_check;

ALTER TABLE competition.my_fpl_snapshot_publications
  ADD CONSTRAINT my_fpl_snapshot_publications_score_source_check
  CHECK (
    score_source IS NULL
    OR score_source = ANY (ARRAY['FPL_EVENT_LIVE'::text, 'FPL_FINAL_RESULT'::text])
  );

ALTER TABLE competition.my_fpl_snapshot_publications
  DROP CONSTRAINT IF EXISTS my_fpl_snapshot_publications_source_span_check;

ALTER TABLE competition.my_fpl_snapshot_publications
  ADD CONSTRAINT my_fpl_snapshot_publications_source_span_check
  CHECK (
    source_min_checked_at IS NULL
    OR source_max_checked_at IS NULL
    OR source_min_checked_at <= source_max_checked_at
  );

COMMENT ON COLUMN competition.my_fpl_snapshot_publications.score_source IS
  'Headline score authority: revision-pinned FPL event-live projection or finalized entry result';
COMMENT ON COLUMN competition.my_fpl_snapshot_publications.source_checked_at IS
  'Conservative minimum source timestamp for the publication';
COMMENT ON COLUMN competition.my_fpl_snapshot_publications.source_min_checked_at IS
  'Oldest source timestamp used by the publication';
COMMENT ON COLUMN competition.my_fpl_snapshot_publications.source_max_checked_at IS
  'Newest source timestamp used by the publication';
