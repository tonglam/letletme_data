-- Add cross-object integrity only after conversion, index every FK, then validate all gates.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
SET LOCAL ROLE letletme_data_owner;

DO $add_v3_foreign_keys$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT *
    FROM (VALUES
      ('fpl.players', 'players_team_fk',
        'FOREIGN KEY (season_id, team_id) REFERENCES fpl.teams(season_id, team_id)'),
      ('fpl.events', 'events_top_element_fk',
        'FOREIGN KEY (season_id, top_element) REFERENCES fpl.players(season_id, element_id)'),
      ('fpl.events', 'events_most_selected_fk',
        'FOREIGN KEY (season_id, most_selected) REFERENCES fpl.players(season_id, element_id)'),
      ('fpl.events', 'events_most_transferred_fk',
        'FOREIGN KEY (season_id, most_transferred_in) REFERENCES fpl.players(season_id, element_id)'),
      ('fpl.events', 'events_most_captained_fk',
        'FOREIGN KEY (season_id, most_captained) REFERENCES fpl.players(season_id, element_id)'),
      ('fpl.events', 'events_most_vice_captained_fk',
        'FOREIGN KEY (season_id, most_vice_captained) REFERENCES fpl.players(season_id, element_id)'),
      ('fpl.phases', 'phases_start_event_fk',
        'FOREIGN KEY (season_id, start_event) REFERENCES fpl.events(season_id, event_id)'),
      ('fpl.phases', 'phases_stop_event_fk',
        'FOREIGN KEY (season_id, stop_event) REFERENCES fpl.events(season_id, event_id)'),
      ('fpl.fixtures', 'fixtures_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('fpl.fixtures', 'fixtures_home_team_fk',
        'FOREIGN KEY (season_id, team_h_id) REFERENCES fpl.teams(season_id, team_id)'),
      ('fpl.fixtures', 'fixtures_away_team_fk',
        'FOREIGN KEY (season_id, team_a_id) REFERENCES fpl.teams(season_id, team_id)'),
      ('fpl.player_event_snapshots', 'player_event_snapshots_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('fpl.player_event_snapshots', 'player_event_snapshots_player_fk',
        'FOREIGN KEY (season_id, element_id) REFERENCES fpl.players(season_id, element_id)'),
      ('fpl.player_gameweek_stats', 'player_gameweek_stats_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('fpl.player_gameweek_stats', 'player_gameweek_stats_player_fk',
        'FOREIGN KEY (season_id, element_id) REFERENCES fpl.players(season_id, element_id)'),
      ('fpl.player_gameweek_scoring_items', 'player_scoring_gameweek_fk',
        'FOREIGN KEY (season_id, event_id, element_id) REFERENCES fpl.player_gameweek_stats(season_id, event_id, element_id)'),
      ('fpl.player_fixture_stats', 'player_fixture_stats_fixture_fk',
        'FOREIGN KEY (season_id, fixture_id) REFERENCES fpl.fixtures(season_id, fixture_id)'),
      ('fpl.player_fixture_stats', 'player_fixture_stats_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('fpl.player_fixture_stats', 'player_fixture_stats_player_fk',
        'FOREIGN KEY (season_id, element_id) REFERENCES fpl.players(season_id, element_id)'),
      ('fpl.player_fixture_stats', 'player_fixture_stats_team_fk',
        'FOREIGN KEY (season_id, team_id) REFERENCES fpl.teams(season_id, team_id)'),
      ('fpl.player_market_snapshots', 'player_market_snapshots_player_fk',
        'FOREIGN KEY (season_id, element_id) REFERENCES fpl.players(season_id, element_id)'),
      ('fpl.player_market_snapshots', 'player_market_snapshots_team_fk',
        'FOREIGN KEY (season_id, team_id) REFERENCES fpl.teams(season_id, team_id)'),
      ('fpl.player_market_snapshots', 'player_market_snapshots_event_fk',
        'FOREIGN KEY (season_id, source_event_id) REFERENCES fpl.events(season_id, event_id)'),

      ('competition.entry_leagues', 'entry_leagues_entry_fk',
        'FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.entry_event_picks', 'entry_event_picks_entry_fk',
        'FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.entry_event_picks', 'entry_event_picks_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.entry_event_picks', 'entry_event_picks_player_fk',
        'FOREIGN KEY (season_id, element_id) REFERENCES fpl.players(season_id, element_id)'),
      ('competition.entry_event_results', 'entry_event_results_entry_fk',
        'FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.entry_event_results', 'entry_event_results_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.entry_event_results', 'entry_event_results_captain_fk',
        'FOREIGN KEY (season_id, played_captain_element_id) REFERENCES fpl.players(season_id, element_id)'),
      ('competition.entry_event_transfers', 'entry_event_transfers_entry_fk',
        'FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.entry_event_transfers', 'entry_event_transfers_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.entry_event_transfers', 'entry_event_transfers_in_player_fk',
        'FOREIGN KEY (season_id, element_in_id) REFERENCES fpl.players(season_id, element_id)'),
      ('competition.entry_event_transfers', 'entry_event_transfers_out_player_fk',
        'FOREIGN KEY (season_id, element_out_id) REFERENCES fpl.players(season_id, element_id)'),
      ('competition.entry_event_cup_results', 'entry_event_cup_results_entry_fk',
        'FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.entry_event_cup_results', 'entry_event_cup_results_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.league_event_results', 'league_event_results_entry_fk',
        'FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.league_event_results', 'league_event_results_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.league_event_results', 'league_event_results_captain_fk',
        'FOREIGN KEY (season_id, captain_element_id) REFERENCES fpl.players(season_id, element_id)'),
      ('competition.league_event_results', 'league_event_results_vice_captain_fk',
        'FOREIGN KEY (season_id, vice_captain_element_id) REFERENCES fpl.players(season_id, element_id)'),
      ('competition.league_event_results', 'league_event_results_played_captain_fk',
        'FOREIGN KEY (season_id, played_captain_element_id) REFERENCES fpl.players(season_id, element_id)'),
      ('competition.league_event_results', 'league_event_results_high_score_fk',
        'FOREIGN KEY (season_id, highest_score_element_id) REFERENCES fpl.players(season_id, element_id)'),
      ('competition.tournaments', 'tournaments_admin_entry_fk',
        'FOREIGN KEY (season_id, admin_entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.tournaments', 'tournaments_group_start_event_fk',
        'FOREIGN KEY (season_id, group_started_event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.tournaments', 'tournaments_group_end_event_fk',
        'FOREIGN KEY (season_id, group_ended_event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.tournaments', 'tournaments_knockout_start_event_fk',
        'FOREIGN KEY (season_id, knockout_started_event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.tournaments', 'tournaments_knockout_end_event_fk',
        'FOREIGN KEY (season_id, knockout_ended_event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.tournament_entries', 'tournament_entries_tournament_fk',
        'FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id)'),
      ('competition.tournament_entries', 'tournament_entries_entry_fk',
        'FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.tournament_groups', 'tournament_groups_tournament_fk',
        'FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id)'),
      ('competition.tournament_groups', 'tournament_groups_entry_fk',
        'FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.tournament_groups', 'tournament_groups_start_event_fk',
        'FOREIGN KEY (season_id, started_event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.tournament_groups', 'tournament_groups_end_event_fk',
        'FOREIGN KEY (season_id, ended_event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.tournament_knockouts', 'tournament_knockouts_tournament_fk',
        'FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id)'),
      ('competition.tournament_knockouts', 'tournament_knockouts_start_event_fk',
        'FOREIGN KEY (season_id, started_event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.tournament_knockouts', 'tournament_knockouts_end_event_fk',
        'FOREIGN KEY (season_id, ended_event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.tournament_knockouts', 'tournament_knockouts_home_entry_fk',
        'FOREIGN KEY (season_id, home_entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.tournament_knockouts', 'tournament_knockouts_away_entry_fk',
        'FOREIGN KEY (season_id, away_entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.tournament_knockouts', 'tournament_knockouts_winner_entry_fk',
        'FOREIGN KEY (season_id, round_winner) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.tournament_battle_group_results', 'tournament_battle_results_tournament_fk',
        'FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id)'),
      ('competition.tournament_battle_group_results', 'tournament_battle_results_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.tournament_battle_group_results', 'tournament_battle_results_home_entry_fk',
        'FOREIGN KEY (season_id, home_entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.tournament_battle_group_results', 'tournament_battle_results_away_entry_fk',
        'FOREIGN KEY (season_id, away_entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.tournament_points_group_results', 'tournament_points_results_tournament_fk',
        'FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id)'),
      ('competition.tournament_points_group_results', 'tournament_points_results_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.tournament_points_group_results', 'tournament_points_results_entry_fk',
        'FOREIGN KEY (season_id, entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.tournament_knockout_results', 'tournament_knockout_results_tournament_fk',
        'FOREIGN KEY (season_id, tournament_id) REFERENCES competition.tournaments(season_id, tournament_id)'),
      ('competition.tournament_knockout_results', 'tournament_knockout_results_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('competition.tournament_knockout_results', 'tournament_knockout_results_home_entry_fk',
        'FOREIGN KEY (season_id, home_entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.tournament_knockout_results', 'tournament_knockout_results_away_entry_fk',
        'FOREIGN KEY (season_id, away_entry_id) REFERENCES competition.entries(season_id, entry_id)'),
      ('competition.tournament_knockout_results', 'tournament_knockout_results_winner_entry_fk',
        'FOREIGN KEY (season_id, match_winner) REFERENCES competition.entries(season_id, entry_id)'),

      ('understat.teams', 'understat_teams_first_season_fk',
        'FOREIGN KEY (first_seen_season) REFERENCES understat.seasons(season_code)'),
      ('understat.teams', 'understat_teams_last_season_fk',
        'FOREIGN KEY (last_seen_season) REFERENCES understat.seasons(season_code)'),
      ('understat.players', 'understat_players_first_season_fk',
        'FOREIGN KEY (first_seen_season) REFERENCES understat.seasons(season_code)'),
      ('understat.players', 'understat_players_last_season_fk',
        'FOREIGN KEY (last_seen_season) REFERENCES understat.seasons(season_code)'),
      ('understat.matches', 'understat_matches_season_fk',
        'FOREIGN KEY (season_code) REFERENCES understat.seasons(season_code)'),
      ('understat.matches', 'understat_matches_home_team_fk',
        'FOREIGN KEY (home_team_id) REFERENCES understat.teams(team_id)'),
      ('understat.matches', 'understat_matches_away_team_fk',
        'FOREIGN KEY (away_team_id) REFERENCES understat.teams(team_id)'),
      ('understat.team_match_stats', 'understat_team_match_stats_match_fk',
        'FOREIGN KEY (match_id) REFERENCES understat.matches(match_id)'),
      ('understat.team_match_stats', 'understat_team_match_stats_team_fk',
        'FOREIGN KEY (team_id) REFERENCES understat.teams(team_id)'),
      ('understat.team_seasons', 'understat_team_seasons_season_fk',
        'FOREIGN KEY (season_code) REFERENCES understat.seasons(season_code)'),
      ('understat.team_seasons', 'understat_team_seasons_team_fk',
        'FOREIGN KEY (team_id) REFERENCES understat.teams(team_id)'),
      ('understat.team_stat_splits', 'understat_team_stat_splits_parent_fk',
        'FOREIGN KEY (season_code, team_id) REFERENCES understat.team_seasons(season_code, team_id)'),
      ('understat.player_seasons', 'understat_player_seasons_season_fk',
        'FOREIGN KEY (season_code) REFERENCES understat.seasons(season_code)'),
      ('understat.player_seasons', 'understat_player_seasons_player_fk',
        'FOREIGN KEY (player_id) REFERENCES understat.players(player_id)'),
      ('understat.player_team_seasons', 'understat_player_team_player_season_fk',
        'FOREIGN KEY (season_code, player_id) REFERENCES understat.player_seasons(season_code, player_id)'),
      ('understat.player_team_seasons', 'understat_player_team_team_season_fk',
        'FOREIGN KEY (season_code, team_id) REFERENCES understat.team_seasons(season_code, team_id)'),
      ('understat.player_match_stats', 'understat_player_match_stats_match_fk',
        'FOREIGN KEY (match_id) REFERENCES understat.matches(match_id)'),
      ('understat.player_match_stats', 'understat_player_match_stats_player_fk',
        'FOREIGN KEY (player_id) REFERENCES understat.players(player_id)'),
      ('understat.player_match_stats', 'understat_player_match_stats_team_fk',
        'FOREIGN KEY (team_id) REFERENCES understat.teams(team_id)'),
      ('understat.player_match_stats', 'understat_player_match_stats_roster_in_fk',
        'FOREIGN KEY (roster_in_id) REFERENCES understat.player_match_stats(roster_id)'),
      ('understat.player_match_stats', 'understat_player_match_stats_roster_out_fk',
        'FOREIGN KEY (roster_out_id) REFERENCES understat.player_match_stats(roster_id)'),

      ('ops.dataset_publications', 'dataset_publications_season_fk',
        'FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id)'),
      ('ops.dataset_publications', 'dataset_publications_event_fk',
        'FOREIGN KEY (season_id, event_id) REFERENCES fpl.events(season_id, event_id)'),
      ('ops.dataset_publications', 'dataset_publications_source_run_fk',
        'FOREIGN KEY (source_run_id) REFERENCES ops.sync_runs(run_id)'),
      ('ops.sync_runs', 'sync_runs_season_fk',
        'FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id)'),
      ('ops.sync_runs', 'sync_runs_publication_fk',
        'FOREIGN KEY (publication_id) REFERENCES ops.dataset_publications(publication_id)'),
      ('ops.season_imports', 'season_imports_season_fk',
        'FOREIGN KEY (season_id) REFERENCES fpl.seasons(season_id)')
    ) AS definitions(table_name, constraint_name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint constraint_row
      WHERE constraint_row.conrelid = to_regclass(spec.table_name)
        AND constraint_row.conname = spec.constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I %s NOT VALID',
        spec.table_name,
        spec.constraint_name,
        spec.definition
      );
    END IF;
  END LOOP;
END
$add_v3_foreign_keys$;

-- Build an exact leading-column index for every FK that does not already have one.
DO $index_v3_foreign_keys$
DECLARE
  fk record;
  index_name text;
  indexed_columns text;
BEGIN
  FOR fk IN
    SELECT
      constraint_row.oid AS constraint_oid,
      constraint_row.conname,
      constraint_row.conrelid,
      constraint_row.conkey,
      namespace_row.nspname AS schema_name,
      relation_row.relname AS table_name
    FROM pg_constraint constraint_row
    JOIN pg_class relation_row ON relation_row.oid = constraint_row.conrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE constraint_row.contype = 'f'
      AND namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'ops')
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index index_row
      WHERE index_row.indrelid = fk.conrelid
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND (
          SELECT array_agg(key_column.attnum ORDER BY key_column.ordinality)
          FROM unnest(index_row.indkey::smallint[]) WITH ORDINALITY
            AS key_column(attnum, ordinality)
          WHERE key_column.ordinality <= cardinality(fk.conkey)
        ) = fk.conkey
    ) THEN
      SELECT string_agg(quote_ident(attribute_row.attname), ', ' ORDER BY key_column.ordinality)
      INTO indexed_columns
      FROM unnest(fk.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
      JOIN pg_attribute attribute_row
        ON attribute_row.attrelid = fk.conrelid
       AND attribute_row.attnum = key_column.attnum;

      index_name := left(fk.conname, 59) || '_idx';
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)',
        index_name,
        fk.schema_name,
        fk.table_name,
        indexed_columns
      );
    END IF;
  END LOOP;
END
$index_v3_foreign_keys$;

DO $validate_v3_foreign_keys$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT namespace_row.nspname AS schema_name, relation_row.relname AS table_name,
      constraint_row.conname
    FROM pg_constraint constraint_row
    JOIN pg_class relation_row ON relation_row.oid = constraint_row.conrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE constraint_row.contype = 'f'
      AND NOT constraint_row.convalidated
      AND namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'ops')
    ORDER BY namespace_row.nspname, relation_row.relname, constraint_row.conname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
      fk.schema_name,
      fk.table_name,
      fk.conname
    );
  END LOOP;
END
$validate_v3_foreign_keys$;

DO $completed_season_shape$
DECLARE
  failure_count integer;
BEGIN
  IF (SELECT metadata ->> 'sourceProfile' FROM ops.migration_runs
      WHERE run_id = 'v3-20260808T160008Z-b9eddc0') = 'fresh_empty' THEN
    RETURN;
  END IF;

  WITH season_counts AS (
    SELECT
      season.season_id,
      season.season_code,
      (SELECT count(*) FROM fpl.teams team WHERE team.season_id = season.season_id) AS teams,
      (SELECT count(*) FROM fpl.events event WHERE event.season_id = season.season_id) AS events,
      (SELECT count(*) FROM fpl.fixtures fixture WHERE fixture.season_id = season.season_id) AS fixtures
    FROM fpl.seasons season
    WHERE season.lifecycle_state = 'completed'
  )
  SELECT count(*) INTO failure_count
  FROM season_counts
  WHERE teams <> 20 OR events <> 38 OR fixtures <> 380;

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'completed FPL season shape failures: %', failure_count;
  END IF;

  WITH team_fixture_counts AS (
    SELECT
      team.season_id,
      team.team_id,
      count(fixture.fixture_id) AS fixtures
    FROM fpl.teams team
    JOIN fpl.seasons season
      ON season.season_id = team.season_id
     AND season.lifecycle_state = 'completed'
    LEFT JOIN fpl.fixtures fixture
      ON fixture.season_id = team.season_id
     AND (fixture.team_h_id = team.team_id OR fixture.team_a_id = team.team_id)
    GROUP BY team.season_id, team.team_id
  )
  SELECT count(*) INTO failure_count FROM team_fixture_counts WHERE fixtures <> 38;

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'completed FPL team fixture-count failures: %', failure_count;
  END IF;
END
$completed_season_shape$;

DO $derived_contracts$
BEGIN
  IF (SELECT count(*) FROM fpl.seasons WHERE is_current) <> 1 THEN
    RAISE EXCEPTION 'fpl.seasons must expose exactly one current row';
  END IF;

  IF (SELECT metadata ->> 'sourceProfile' FROM ops.migration_runs
      WHERE run_id = 'v3-20260808T160008Z-b9eddc0') = 'b0_nonempty' THEN
    IF (
      SELECT count(*)
      FROM reporting.player_season_summaries summary
      JOIN fpl.seasons season ON season.season_id = summary.season_id
      WHERE season.season_code = '2526'
    ) <> 841 THEN
      RAISE EXCEPTION '2526 player season summary count is not 841';
    END IF;

    IF (
      SELECT count(*)
      FROM fpl.player_market_snapshots
      WHERE snapshot_source = 'legacy_value_seed'
    ) <> 564 THEN
      RAISE EXCEPTION 'B0 legacy value seed count is not 564';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM fpl.teams)
     OR EXISTS (SELECT 1 FROM fpl.players)
     OR EXISTS (SELECT 1 FROM fpl.events)
     OR EXISTS (SELECT 1 FROM fpl.fixtures)
     OR EXISTS (SELECT 1 FROM fpl.player_event_snapshots)
     OR EXISTS (SELECT 1 FROM fpl.player_gameweek_stats)
     OR EXISTS (SELECT 1 FROM fpl.player_gameweek_scoring_items)
     OR EXISTS (SELECT 1 FROM fpl.player_fixture_stats)
     OR EXISTS (SELECT 1 FROM fpl.player_market_snapshots)
     OR EXISTS (SELECT 1 FROM reporting.player_season_summaries)
     OR EXISTS (SELECT 1 FROM reporting.player_value_changes) THEN
    RAISE EXCEPTION 'fresh-empty source unexpectedly produced FPL fact rows';
  END IF;
END
$derived_contracts$;

DO $security_contracts$
DECLARE
  role_name text;
  schema_name text;
  failure_count integer;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops']
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_namespace namespace_row
      CROSS JOIN LATERAL aclexplode(
        COALESCE(namespace_row.nspacl, acldefault('n', namespace_row.nspowner))
      ) acl_row
      WHERE namespace_row.nspname = schema_name
        AND acl_row.grantee = 0
        AND acl_row.privilege_type = 'USAGE'
    ) THEN
      RAISE EXCEPTION 'PUBLIC unexpectedly has USAGE on schema %', schema_name;
    END IF;

    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name)
         AND has_schema_privilege(role_name, schema_name, 'USAGE') THEN
        RAISE EXCEPTION '% unexpectedly has USAGE on schema %', role_name, schema_name;
      END IF;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO failure_count
  FROM pg_class relation_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops')
    AND relation_row.relkind IN ('r', 'p', 'v', 'm')
    AND (
      has_table_privilege('letletme_graphql_reader', relation_row.oid, 'INSERT')
      OR has_table_privilege('letletme_graphql_reader', relation_row.oid, 'UPDATE')
      OR has_table_privilege('letletme_graphql_reader', relation_row.oid, 'DELETE')
      OR has_table_privilege('letletme_graphql_reader', relation_row.oid, 'TRUNCATE')
    );

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'GraphQL reader has write privileges on % v3 relations', failure_count;
  END IF;

  SELECT count(*) INTO failure_count
  FROM pg_class relation_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = 'reporting'
    AND relation_row.relkind = 'v'
    AND NOT (COALESCE(relation_row.reloptions, '{}'::text[]) @> ARRAY['security_invoker=true']);

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'reporting ordinary views missing security_invoker: %', failure_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc function_row
    CROSS JOIN LATERAL aclexplode(
      COALESCE(function_row.proacl, acldefault('f', function_row.proowner))
    ) acl_row
    WHERE function_row.oid IN (
      'reporting.refresh_tournament_selection_stats()'::regprocedure,
      'reporting.refresh_tournament_entry_event_summaries()'::regprocedure
    )
      AND acl_row.grantee = 0
      AND acl_row.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC unexpectedly has reporting refresh EXECUTE';
  END IF;
END
$security_contracts$;

DO $foreign_key_index_contract$
DECLARE
  failure_count integer;
BEGIN
  SELECT count(*) INTO failure_count
  FROM pg_constraint constraint_row
  JOIN pg_class relation_row ON relation_row.oid = constraint_row.conrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE constraint_row.contype = 'f'
    AND namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'ops')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index index_row
      WHERE index_row.indrelid = constraint_row.conrelid
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND (
          SELECT array_agg(key_column.attnum ORDER BY key_column.ordinality)
          FROM unnest(index_row.indkey::smallint[]) WITH ORDINALITY
            AS key_column(attnum, ordinality)
          WHERE key_column.ordinality <= cardinality(constraint_row.conkey)
        ) = constraint_row.conkey
    );

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'v3 foreign keys without supporting indexes: %', failure_count;
  END IF;

  SELECT count(*) INTO failure_count
  FROM pg_constraint constraint_row
  JOIN pg_class relation_row ON relation_row.oid = constraint_row.conrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE constraint_row.contype IN ('c', 'f')
    AND NOT constraint_row.convalidated
    AND namespace_row.nspname IN ('fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops');

  IF failure_count <> 0 THEN
    RAISE EXCEPTION 'unvalidated v3 constraints: %', failure_count;
  END IF;
END
$foreign_key_index_contract$;

INSERT INTO ops.migration_objects (
  run_id,
  check_name,
  source_object,
  target_object,
  query_sha256,
  source_row_count,
  target_row_count,
  source_hash,
  target_hash,
  failed_count,
  sample_failed_keys,
  status
)
SELECT
  run.run_id,
  '0088_v3_constraint_and_security_contract',
  'public.v2_manifest',
  'v3.schemas',
  encode(sha256(convert_to('0088_v3_constraint_and_security_contract_v1', 'UTF8')), 'hex'),
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  '[]'::jsonb,
  'passed'
FROM ops.migration_runs run
WHERE run.run_id = 'v3-20260808T160008Z-b9eddc0'
ON CONFLICT (run_id, check_name, source_object, target_object) DO UPDATE SET
  query_sha256 = EXCLUDED.query_sha256,
  failed_count = EXCLUDED.failed_count,
  sample_failed_keys = EXCLUDED.sample_failed_keys,
  status = EXCLUDED.status,
  executed_at = now();

UPDATE ops.migration_runs
SET status = 'validated', updated_at = now()
WHERE run_id = 'v3-20260808T160008Z-b9eddc0'
  AND status = 'running';

RESET ROLE;
