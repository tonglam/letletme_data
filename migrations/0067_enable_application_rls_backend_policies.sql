-- Protect the application-owned data schemas from accidental broad reads while
-- retaining the existing least-privilege backend role contract.  These tables
-- are intentionally backend-only: the writer role may perform its existing
-- operations, and the GraphQL reader may SELECT; anon/authenticated receive no
-- grants or policies.
DO $migration$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('ops', 'schema_migrations'),
      ('ops', 'dataset_publications'),
      ('ops', 'sync_runs'),
      ('ops', 'sync_items'),
      ('ops', 'season_imports'),
      ('fpl', 'seasons'),
      ('fpl', 'events'),
      ('fpl', 'teams'),
      ('fpl', 'players'),
      ('fpl', 'phases'),
      ('fpl', 'fixtures'),
      ('fpl', 'player_event_snapshots'),
      ('fpl', 'player_gameweek_stats'),
      ('fpl', 'player_gameweek_scoring_items'),
      ('fpl', 'player_fixture_stats'),
      ('fpl', 'player_market_snapshots'),
      ('competition', 'entries'),
      ('competition', 'entry_season_histories'),
      ('competition', 'entry_leagues'),
      ('competition', 'entry_event_picks'),
      ('competition', 'entry_event_results'),
      ('competition', 'entry_event_transfers'),
      ('competition', 'entry_event_cup_results'),
      ('competition', 'league_event_results'),
      ('competition', 'tournaments'),
      ('competition', 'tournament_entries'),
      ('competition', 'tournament_groups'),
      ('competition', 'tournament_knockouts'),
      ('competition', 'tournament_battle_group_results'),
      ('competition', 'tournament_points_group_results'),
      ('competition', 'tournament_knockout_results'),
      ('competition', 'public_league_trends'),
      ('ops', 'dataset_publication_items'),
      ('ops', 'bug_reports'),
      ('ops', 'bug_report_retention_backups'),
      ('ops', 'bug_report_storage_migrations'),
      ('competition', 'tournament_setup_issues'),
      ('ops', 'mutation_scopes'),
      ('fpl', 'player_event_snapshot_publications'),
      ('ops', 'live_lifecycle_status'),
      ('fpl', 'manager_event_score_snapshots'),
      ('ops', 'data_publication_outbox'),
      ('ops', 'scheduler_obligations'),
      ('competition', 'entry_past_seasons'),
      ('competition', 'my_fpl_snapshot_publication_outbox'),
      ('ops', 'fpl_source_artifacts'),
      ('ops', 'scheduler_lanes'),
      ('fpl', 'manager_live_tournament_coverage'),
      ('ops', 'queue_health_windows'),
      ('ops', 'data_governance_cases'),
      ('competition', 'tournament_official_h2h_page_manifests'),
      ('ops', 'freshness_slo_windows'),
      ('fpl', 'manager_event_score_materializations'),
      ('fpl', 'manager_event_score_heads'),
      ('ops', 'client_signal_batches'),
      ('ops', 'client_signal_windows')
    ) AS listed(schema_name, table_name)
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      target.schema_name,
      target.table_name
    );

    IF NOT EXISTS (
      SELECT 1
      FROM pg_policy
      WHERE polrelid = to_regclass(format('%I.%I', target.schema_name, target.table_name))
        AND polname = 'letletme_data_writer_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY letletme_data_writer_all ON %I.%I FOR ALL TO letletme_data_writer USING (true) WITH CHECK (true)',
        target.schema_name,
        target.table_name
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_policy
      WHERE polrelid = to_regclass(format('%I.%I', target.schema_name, target.table_name))
        AND polname = 'letletme_graphql_reader_select'
    ) THEN
      EXECUTE format(
        'CREATE POLICY letletme_graphql_reader_select ON %I.%I FOR SELECT TO letletme_graphql_reader USING (true)',
        target.schema_name,
        target.table_name
      );
    END IF;
  END LOOP;
END
$migration$;
