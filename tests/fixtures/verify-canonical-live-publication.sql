DO $canonical_live_publication_fixture$
DECLARE
  fixture_manifest jsonb;
BEGIN
  SELECT manifest INTO fixture_manifest
  FROM ops.dataset_publications
  WHERE publication_id = '11111111-1111-4111-8111-111111111111'::uuid
    AND dataset = 'fpl:live'
    AND status = 'active';

  IF fixture_manifest IS NULL
    OR NOT fixture_manifest ?& ARRAY[
      'dataset', 'seasonCode', 'eventId', 'revision', 'publicationId',
      'sourceCheckedAt', 'publishedAt', 'state', 'items'
    ]
    OR fixture_manifest - ARRAY[
      'dataset', 'seasonCode', 'eventId', 'revision', 'publicationId',
      'sourceCheckedAt', 'publishedAt', 'state', 'items'
    ] <> '{}'::jsonb
    OR fixture_manifest ->> 'state' <> 'live'
    OR jsonb_array_length(fixture_manifest -> 'items') <> 4
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(fixture_manifest -> 'items') item
      WHERE coalesce(item ->> 'key', '') !~ '^llm:data:fpl:live:'
    )
  THEN
    RAISE EXCEPTION 'active live publication was not canonicalized exactly';
  END IF;

  DELETE FROM ops.dataset_publications
  WHERE publication_id = '11111111-1111-4111-8111-111111111111'::uuid;

  DELETE FROM fpl.events
  WHERE name = '__canonical_live_migration_fixture__';
END
$canonical_live_publication_fixture$;
