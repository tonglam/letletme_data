-- Absorb the public-league catalog introduced on the GraphQL mainline into the
-- Data-owned competition schema. GraphQL remains a read-only consumer.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL ROLE letletme_data_owner;

CREATE TABLE competition.public_league_trends (
  season_id smallint NOT NULL,
  tournament_id integer NOT NULL,
  display_name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_league_trends_pkey PRIMARY KEY (season_id, tournament_id),
  CONSTRAINT public_league_trends_tournament_fk
    FOREIGN KEY (season_id, tournament_id)
    REFERENCES competition.tournaments (season_id, tournament_id)
    ON DELETE CASCADE,
  CONSTRAINT public_league_trends_tournament_id_positive CHECK (tournament_id > 0),
  CONSTRAINT public_league_trends_display_name_nonempty CHECK (btrim(display_name) <> ''),
  CONSTRAINT public_league_trends_sort_order_nonnegative CHECK (sort_order >= 0)
);

CREATE INDEX public_league_trends_listing_idx
  ON competition.public_league_trends (
    season_id,
    enabled,
    sort_order,
    tournament_id
  );

-- The accepted B0 baseline has no source relation. This guarded copy keeps a
-- later rehearsal fail-safe if the unshipped GraphQL migration appears before cutover.
DO $copy_graphql_catalog$
BEGIN
  IF to_regclass('public.public_league_trends_catalog') IS NOT NULL THEN
    EXECUTE $copy$
      INSERT INTO competition.public_league_trends (
        season_id,
        tournament_id,
        display_name,
        sort_order,
        enabled,
        published_at,
        created_at,
        updated_at
      )
      SELECT
        tournament.season_id,
        catalog.tournament_id,
        catalog.display_name,
        catalog.sort_order,
        catalog.enabled,
        catalog.published_at,
        catalog.published_at,
        catalog.updated_at
      FROM public.public_league_trends_catalog catalog
      JOIN competition.tournaments tournament
        ON tournament.tournament_id = catalog.tournament_id
      ON CONFLICT (season_id, tournament_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        sort_order = EXCLUDED.sort_order,
        enabled = EXCLUDED.enabled,
        published_at = EXCLUDED.published_at,
        updated_at = EXCLUDED.updated_at
    $copy$;
  END IF;
END
$copy_graphql_catalog$;

REVOKE ALL ON competition.public_league_trends FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON competition.public_league_trends
TO letletme_data_writer;
GRANT SELECT ON competition.public_league_trends TO letletme_graphql_reader;

UPDATE ops.dataset_publications
SET
  manifest = jsonb_set(manifest, '{planVersion}', '"3.2.3"'::jsonb, true),
  updated_at = now()
WHERE manifest ->> 'schemaVersion' = 'v3'
  AND manifest ->> 'planVersion' IS DISTINCT FROM '3.2.3';

RESET ROLE;
