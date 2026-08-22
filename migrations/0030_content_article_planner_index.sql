-- Keep triggered Article retries on the same bounded round-robin index as transcript work.

DROP INDEX content.content_source_receipts_work_planner_idx;

CREATE INDEX content_source_receipts_work_planner_idx
  ON content.source_receipts (work_planner_checked_at ASC NULLS FIRST, created_at DESC)
  WHERE content_kind IN ('ARTICLE', 'EPISODE', 'VIDEO');
