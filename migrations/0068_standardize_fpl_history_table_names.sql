-- Standardize FPL history names without moving rows.
--
-- Core tables remain the current-season source of truth. History parents use
-- <core_table>_history and their physical LIST partitions use
-- <core_table>_<season>. ALTER TABLE RENAME preserves the existing relation,
-- partition attachment, constraints, indexes, RLS, and rows.

DO $$
DECLARE
  mapping record;
  season text;
  old_partition text;
  new_partition text;
BEGIN
  FOR mapping IN
    SELECT *
    FROM (
      VALUES
        ('fpl_event_history', 'events_history', 'event', 'events'),
        ('fpl_team_history', 'teams_history', 'team', 'teams'),
        ('fpl_player_history', 'players_history', 'player', 'players'),
        ('fpl_phase_history', 'phases_history', 'phase', 'phases'),
        ('fpl_event_fixture_history', 'event_fixtures_history', 'event_fixture', 'event_fixtures'),
        ('fpl_player_stat_history', 'player_stats_history', 'player_stat', 'player_stats'),
        ('fpl_event_live_history', 'event_lives_history', 'event_live', 'event_lives'),
        ('fpl_event_live_explain_history', 'event_live_explains_history', 'event_live_explain', 'event_live_explains'),
        ('fpl_event_live_summary_history', 'event_live_summaries_history', 'event_live_summary', 'event_live_summaries'),
        ('fpl_player_value_history', 'player_values_history', 'player_value', 'player_values'),
        ('fpl_player_market_snapshot_history', 'player_market_snapshots_history', 'player_market_snapshot', 'player_market_snapshots'),
        ('fpl_player_fixture_stat_history', 'fpl_player_fixture_stats_history', 'fpl_player_fixture_stat', 'fpl_player_fixture_stats')
    ) AS names(old_parent, new_parent, old_prefix, new_prefix)
  LOOP
    IF to_regclass(format('public.%I', mapping.old_parent)) IS NOT NULL THEN
      IF to_regclass(format('public.%I', mapping.new_parent)) IS NOT NULL THEN
        RAISE EXCEPTION
          'Cannot standardize FPL history parent %: target % already exists',
          mapping.old_parent,
          mapping.new_parent;
      END IF;
      EXECUTE format(
        'ALTER TABLE public.%I RENAME TO %I',
        mapping.old_parent,
        mapping.new_parent
      );
    END IF;

    FOREACH season IN ARRAY ARRAY[
      '1617', '1718', '1819', '1920', '2021', '2122',
      '2223', '2324', '2425', '2526', '2627'
    ]
    LOOP
      old_partition := mapping.old_prefix || '_' || season;
      new_partition := mapping.new_prefix || '_' || season;

      IF to_regclass(format('public.%I', old_partition)) IS NOT NULL THEN
        IF to_regclass(format('public.%I', new_partition)) IS NOT NULL THEN
          RAISE EXCEPTION
            'Cannot standardize FPL history partition %: target % already exists',
            old_partition,
            new_partition;
        END IF;
        EXECUTE format(
          'ALTER TABLE public.%I RENAME TO %I',
          old_partition,
          new_partition
        );
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Archive items store the logical parent name as metadata. Update that
-- pointer only; no archived business rows are copied, deleted, or rewritten.
UPDATE public.fpl_season_archive_items
SET archive_table = CASE archive_table
  WHEN 'fpl_event_history' THEN 'events_history'
  WHEN 'fpl_team_history' THEN 'teams_history'
  WHEN 'fpl_player_history' THEN 'players_history'
  WHEN 'fpl_phase_history' THEN 'phases_history'
  WHEN 'fpl_event_fixture_history' THEN 'event_fixtures_history'
  WHEN 'fpl_player_stat_history' THEN 'player_stats_history'
  WHEN 'fpl_event_live_history' THEN 'event_lives_history'
  WHEN 'fpl_event_live_explain_history' THEN 'event_live_explains_history'
  WHEN 'fpl_event_live_summary_history' THEN 'event_live_summaries_history'
  WHEN 'fpl_player_value_history' THEN 'player_values_history'
  WHEN 'fpl_player_market_snapshot_history' THEN 'player_market_snapshots_history'
  WHEN 'fpl_player_fixture_stat_history' THEN 'fpl_player_fixture_stats_history'
  ELSE archive_table
END
WHERE archive_table IN (
  'fpl_event_history',
  'fpl_team_history',
  'fpl_player_history',
  'fpl_phase_history',
  'fpl_event_fixture_history',
  'fpl_player_stat_history',
  'fpl_event_live_history',
  'fpl_event_live_explain_history',
  'fpl_event_live_summary_history',
  'fpl_player_value_history',
  'fpl_player_market_snapshot_history',
  'fpl_player_fixture_stat_history'
);
