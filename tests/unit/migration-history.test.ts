import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import { inspectMigrationHistory } from '../../scripts/migration-history';

describe('migration history inspection', () => {
  test('accepts unapplied migrations after the applied tail', () => {
    expect(
      inspectMigrationHistory(
        ['0031_first.sql', '0032_second.sql', '0033_third.sql'],
        ['0031_first.sql', '0032_second.sql'],
      ),
    ).toEqual({
      missing: [],
      backdated: [],
      latestApplied: '0032_second.sql',
    });
  });

  test('reports missing ledger files and migrations inserted before the applied tail', () => {
    expect(
      inspectMigrationHistory(
        ['0030_backdated.sql', '0031_first.sql', '0033_third.sql'],
        ['0031_first.sql', '0032_missing.sql'],
      ),
    ).toEqual({
      missing: ['0032_missing.sql'],
      backdated: ['0030_backdated.sql'],
      latestApplied: '0032_missing.sql',
    });
  });

  test('has no applied tail for a fresh database', () => {
    expect(inspectMigrationHistory(['0006_first.sql'], [])).toEqual({
      missing: [],
      backdated: [],
      latestApplied: null,
    });
  });

  test('places every tournament lifecycle migration after the deployed Live tail', () => {
    const files = readdirSync('migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const applied = files.filter((file) => file <= '0039_add_live_snapshot_write_fence.sql');

    expect(inspectMigrationHistory(files, applied)).toMatchObject({
      missing: [],
      backdated: [],
      latestApplied: '0039_add_live_snapshot_write_fence.sql',
    });
    expect(files.filter((file) => file.includes('tournament_lifecycle_progress'))).toEqual([
      '0040_tournament_lifecycle_progress.sql',
    ]);
  });
});

describe('public Data API lockdown migration', () => {
  test('is scoped to Data-owned relations in the shared public schema', () => {
    const migration = readFileSync('migrations/0033_lock_down_public_data_api.sql', 'utf8');

    expect(migration).toContain('target_tables text[]');
    expect(migration).toMatch(/'events'/);
    expect(migration).toMatch(/'tournament_infos'/);
    expect(migration).not.toContain('ON ALL TABLES IN SCHEMA public');
    expect(migration).not.toContain('ALTER DEFAULT PRIVILEGES');
  });
});

describe('player market snapshot migration', () => {
  test('creates a unique complete-day store behind the service trust boundary', () => {
    const migration = readFileSync('migrations/0037_create_player_market_snapshots.sql', 'utf8');

    expect(migration).toContain('player_market_snapshots');
    expect(migration).toContain('snapshot_date, element_id');
    expect(migration).toContain('selected_by_percent BETWEEN 0 AND 100');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE');
  });
});

describe('tournament lifecycle progress migration', () => {
  test('restores readiness only for legacy tournaments with canonical structure', () => {
    const migration = readFileSync('migrations/0040_tournament_lifecycle_progress.sql', 'utf8');

    expect(migration).toMatch(/setup_status = 'ready'/);
    expect(migration).toMatch(/FROM public\.tournament_entries/);
    expect(migration).toMatch(/FROM public\.tournament_groups/);
    expect(migration).toMatch(/FROM public\.tournament_knockouts/);
  });
});

describe('core snapshot authority migration', () => {
  test('installs a singleton revision authority outside the client Data API', () => {
    const migration = readFileSync('migrations/0049_core_snapshot_authority.sql', 'utf8');

    expect(migration).toContain('core_snapshot_revision_seq');
    expect(migration).toContain('core_snapshot_authority');
    expect(migration).toContain('CHECK (singleton_id = 1)');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE');
    expect(migration).toContain('REVOKE ALL ON SEQUENCE');
    expect(migration).toContain('price_source_checked_at');
  });
});

describe('GraphQL read RPC migration', () => {
  test('rebuilds only the legacy picker signatures when their OUT type changes', () => {
    const migration = readFileSync('migrations/0043_create_graphql_read_rpcs.sql', 'utf8');

    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.get_players_for_picker(integer, integer)',
    );
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.search_players_for_picker(text, integer, integer)',
    );
    expect(migration).not.toMatch(/DROP FUNCTION[^;]+CASCADE/);
  });
});

describe('Understat provider migrations', () => {
  test('create isolated provider, archive, bridge, and FPL evidence stores behind RLS', () => {
    const names = {
      50: 'create_understat_provider_tables',
      51: 'create_understat_sync_state',
      52: 'create_provider_identity_bridge',
      53: 'create_fpl_player_fixture_stats',
      54: 'create_fpl_history_archive',
      55: 'create_fpl_2627_history_partitions',
    } as const;
    const migrations = [50, 51, 52, 53, 54, 55].map((number) =>
      readFileSync(`migrations/00${number}_${names[number as keyof typeof names]}.sql`, 'utf8'),
    );
    for (const migration of migrations) {
      expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
      expect(migration).toContain('REVOKE ALL ON TABLE');
    }
    expect(migrations[0]).toContain('numeric(14, 8)');
    expect(migrations[0]).toContain('understat_player_team_seasons');
    expect(migrations[1]).toContain('ready_to_publish');
    expect(migrations[2]).toContain('quarantined');
    expect(migrations[3]).toContain('player_code');
    expect(migrations[3]).toContain('starts integer');
    expect(migrations[4]).toContain('fpl_season_archives');
    expect(migrations[4]).toMatch(/'2526',/);
    expect(migrations[4]).toContain('reject_sealed_fpl_history_mutation');
    expect(migrations[4]).not.toContain('TRUNCATE');
    expect(migrations[5]).toContain('event_fixture_2627');
    expect(migrations[5]).toContain('fpl_player_fixture_stat_2627');
  });
});

describe('entry result rich checkpoint migration', () => {
  test('follows core authority and preserves the existing table security boundary', () => {
    const migration = readFileSync(
      'migrations/0072_entry_event_result_rich_checkpoint.sql',
      'utf8',
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS rich_synced_at timestamptz');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS source_checked_at timestamptz');
    expect(migration).not.toContain('GRANT');
  });
});

describe('event finalization checkpoint migration', () => {
  test('adds a stable cutoff without changing the existing table security boundary', () => {
    const migration = readFileSync('migrations/0073_event_data_checked_at.sql', 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS data_checked_at timestamptz');
    expect(migration).toContain('WHERE data_checked = true');
    expect(migration).toContain('statement_timestamp()');
    expect(migration).not.toContain('GRANT');
  });
});

describe('event history archive alignment migration', () => {
  test('extends the history parent with the event finalization timestamp', () => {
    const migration = readFileSync('migrations/0079_align_fpl_event_history.sql', 'utf8');

    expect(migration).toContain('ALTER TABLE public.events_history');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS data_checked_at timestamptz');
  });
});

describe('event live summary season aggregate migration', () => {
  test('removes event/team dimensions and rebuilds from event-live facts', () => {
    const migration = readFileSync(
      'migrations/0069_standardize_event_live_summaries_to_season_aggregate.sql',
      'utf8',
    );

    expect(migration).toContain('DROP COLUMN IF EXISTS event_id CASCADE');
    expect(migration).toContain('DROP COLUMN IF EXISTS team_id CASCADE');
    expect(migration).toContain('FROM public.event_lives AS live');
    expect(migration).toContain('FROM public.event_lives_history AS live');
    expect(migration).toContain('GROUP BY live.season, live.element_id, player.type');
  });
});
