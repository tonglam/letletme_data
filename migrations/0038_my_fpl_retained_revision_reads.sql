-- My FPL clients pin one immutable revision across the related desk,
-- gameweek, transfer and competition requests. Keep superseded publications
-- readable by the restricted GraphQL role for the same 24-hour window in
-- which the writer retains them; active publications remain readable without
-- an age limit. `updated_at` is the superseded-at timestamp because
-- `published_at` may predate the active-pointer switch by more than 24 hours.

DROP POLICY IF EXISTS my_fpl_snapshot_publications_graphql_active
  ON competition.my_fpl_snapshot_publications;
DROP POLICY IF EXISTS my_fpl_snapshot_publications_graphql_readable
  ON competition.my_fpl_snapshot_publications;
CREATE POLICY my_fpl_snapshot_publications_graphql_readable
  ON competition.my_fpl_snapshot_publications
  FOR SELECT TO letletme_graphql_reader
  USING (
    active
    OR updated_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
  );

DROP POLICY IF EXISTS my_fpl_snapshot_entries_graphql_active
  ON competition.my_fpl_snapshot_entries;
DROP POLICY IF EXISTS my_fpl_snapshot_entries_graphql_readable
  ON competition.my_fpl_snapshot_entries;
CREATE POLICY my_fpl_snapshot_entries_graphql_readable
  ON competition.my_fpl_snapshot_entries
  FOR SELECT TO letletme_graphql_reader
  USING (EXISTS (
    SELECT 1
    FROM competition.my_fpl_snapshot_publications publication
    WHERE publication.season_id = my_fpl_snapshot_entries.season_id
      AND publication.event_id = my_fpl_snapshot_entries.event_id
      AND publication.revision = my_fpl_snapshot_entries.revision
      AND (
        publication.active
        OR publication.updated_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
      )
  ));

DROP POLICY IF EXISTS my_fpl_snapshot_tournament_rows_graphql_active
  ON competition.my_fpl_snapshot_tournament_rows;
DROP POLICY IF EXISTS my_fpl_snapshot_tournament_rows_graphql_readable
  ON competition.my_fpl_snapshot_tournament_rows;
CREATE POLICY my_fpl_snapshot_tournament_rows_graphql_readable
  ON competition.my_fpl_snapshot_tournament_rows
  FOR SELECT TO letletme_graphql_reader
  USING (EXISTS (
    SELECT 1
    FROM competition.my_fpl_snapshot_publications publication
    WHERE publication.season_id = my_fpl_snapshot_tournament_rows.season_id
      AND publication.event_id = my_fpl_snapshot_tournament_rows.event_id
      AND publication.revision = my_fpl_snapshot_tournament_rows.revision
      AND (
        publication.active
        OR publication.updated_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
      )
  ));

DROP POLICY IF EXISTS my_fpl_snapshot_tournament_aggregates_graphql_active
  ON competition.my_fpl_snapshot_tournament_aggregates;
DROP POLICY IF EXISTS my_fpl_snapshot_tournament_aggregates_graphql_readable
  ON competition.my_fpl_snapshot_tournament_aggregates;
CREATE POLICY my_fpl_snapshot_tournament_aggregates_graphql_readable
  ON competition.my_fpl_snapshot_tournament_aggregates
  FOR SELECT TO letletme_graphql_reader
  USING (EXISTS (
    SELECT 1
    FROM competition.my_fpl_snapshot_publications publication
    WHERE publication.season_id = my_fpl_snapshot_tournament_aggregates.season_id
      AND publication.event_id = my_fpl_snapshot_tournament_aggregates.event_id
      AND publication.revision = my_fpl_snapshot_tournament_aggregates.revision
      AND (
        publication.active
        OR publication.updated_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
      )
  ));

COMMENT ON TABLE competition.my_fpl_snapshot_publications IS
  'Atomic My FPL product publications. GraphQL can read the active revision and superseded revisions retained for 24 hours.';
COMMENT ON COLUMN competition.my_fpl_snapshot_publications.active IS
  'The sole active product revision for this season/gameweek; recently superseded revisions remain readable for pinned requests.';

CREATE INDEX my_fpl_snapshot_publications_retention_idx
  ON competition.my_fpl_snapshot_publications(season_id, event_id, updated_at DESC NULLS LAST)
  WHERE NOT active;
