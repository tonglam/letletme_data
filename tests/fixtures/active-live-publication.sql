DO $active_live_publication_fixture$
DECLARE
  fixture_season_id smallint;
  fixture_season_code text;
  fixture_event_id integer;
  fixture_revision bigint;
  fixture_publication_id uuid := '11111111-1111-4111-8111-111111111111'::uuid;
BEGIN
  INSERT INTO fpl.events (season_id, event_id, name)
  SELECT season.season_id, 1, '__canonical_live_migration_fixture__'
  FROM fpl.seasons season
  WHERE season.is_current
    AND NOT EXISTS (
      SELECT 1 FROM fpl.events event WHERE event.season_id = season.season_id
    );

  SELECT season.season_id, season.season_code, min(event.event_id)
  INTO fixture_season_id, fixture_season_code, fixture_event_id
  FROM fpl.seasons season
  JOIN fpl.events event ON event.season_id = season.season_id
  WHERE season.is_current
  GROUP BY season.season_id, season.season_code;

  IF fixture_event_id IS NULL THEN
    RAISE EXCEPTION 'active live publication fixture requires a current-season event';
  END IF;

  fixture_revision := nextval('ops.dataset_publication_revisions');

  INSERT INTO ops.dataset_publications (
    publication_id,
    dataset,
    season_id,
    event_id,
    revision,
    status,
    manifest,
    activated_at,
    created_at,
    updated_at
  ) VALUES (
    fixture_publication_id,
    'fpl:live',
    fixture_season_id,
    fixture_event_id,
    fixture_revision,
    'active',
    jsonb_build_object(
      'schemaVersion', 'v3',
      'planVersion', '3.2.5',
      'state', 'live',
      'items', (
        SELECT jsonb_agg(
          jsonb_build_object(
            'name', item_name,
            'key', format(
              'llm:v3:data:fpl:live:%s:%s:%s:%s',
              fixture_season_code,
              fixture_event_id,
              fixture_revision,
              item_name
            ),
            'type', 'string',
            'count', 0,
            'bytes', 2,
            'sha256', repeat('0', 64)
          )
          ORDER BY item_name
        )
        FROM unnest(ARRAY['eventLives', 'fixtures', 'liveFixtures', 'liveBonus']) item_name
      )
    ),
    now(),
    now(),
    now()
  );
END
$active_live_publication_fixture$;
