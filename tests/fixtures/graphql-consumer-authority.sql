\set ON_ERROR_STOP on

-- Data owns this disposable authority fixture because these INSERT shapes are
-- part of the producer schema, not the GraphQL read contract. A Data schema
-- change that adds a required producer column must update this file in the same
-- change; consumers only execute it before validating their read-only contract.
UPDATE fpl.seasons
SET is_current = FALSE
WHERE is_current;

INSERT INTO fpl.seasons (
  season_id,
  season_code,
  display_name,
  start_year,
  end_year,
  lifecycle_state,
  is_current
) VALUES (
  2026,
  '2627',
  '2026/27',
  2026,
  2027,
  'preseason',
  TRUE
)
ON CONFLICT (season_id) DO UPDATE
SET
  season_code = EXCLUDED.season_code,
  display_name = EXCLUDED.display_name,
  start_year = EXCLUDED.start_year,
  end_year = EXCLUDED.end_year,
  lifecycle_state = EXCLUDED.lifecycle_state,
  is_current = TRUE,
  updated_at = now();

UPDATE ops.dataset_publications
SET status = 'retired', retired_at = now(), updated_at = now()
WHERE dataset = 'fpl:core'
  AND season_id = 2026
  AND event_id IS NULL
  AND status = 'active'
  AND publication_id <> '00000000-0000-4000-8000-000000000007'::uuid;

INSERT INTO ops.dataset_publications (
  publication_id,
  dataset,
  season_id,
  event_id,
  revision,
  status,
  manifest,
  activated_at
) VALUES (
  '00000000-0000-4000-8000-000000000007',
  'fpl:core',
  2026,
  NULL,
  7,
  'active',
  jsonb_build_object(
    'dataset', 'fpl:core',
    'seasonCode', '2627',
    'eventId', NULL,
    'revision', 7,
    'publicationId', '00000000-0000-4000-8000-000000000007',
    'sourceCheckedAt', '2026-08-10T00:00:00.000Z',
    'publishedAt', '2026-08-10T00:00:01.000Z',
    'state', 'active',
    'items', jsonb_build_array(
      jsonb_build_object('name', 'events', 'key', 'llm:data:fpl:core:2627:7:events', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64)),
      jsonb_build_object('name', 'teams', 'key', 'llm:data:fpl:core:2627:7:teams', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64)),
      jsonb_build_object('name', 'players', 'key', 'llm:data:fpl:core:2627:7:players', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64)),
      jsonb_build_object('name', 'phases', 'key', 'llm:data:fpl:core:2627:7:phases', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64)),
      jsonb_build_object('name', 'fixtures', 'key', 'llm:data:fpl:core:2627:7:fixtures', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64)),
      jsonb_build_object('name', 'currentEventId', 'key', 'llm:data:fpl:core:2627:7:currentEventId', 'type', 'string', 'count', 0, 'bytes', 2, 'sha256', repeat('0', 64))
    )
  ),
  now()
)
ON CONFLICT (publication_id) DO UPDATE
SET
  status = 'active',
  manifest = EXCLUDED.manifest,
  activated_at = now(),
  retired_at = NULL,
  updated_at = now();

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM ops.dataset_publications publication
    JOIN fpl.seasons season ON season.season_id = publication.season_id
    WHERE publication.dataset = 'fpl:core'
      AND publication.event_id IS NULL
      AND publication.status = 'active'
      AND season.is_current
      AND jsonb_array_length(publication.manifest -> 'items') = 6
  ) <> 1 THEN
    RAISE EXCEPTION 'expected one canonical core publication fixture';
  END IF;
END
$$;
