import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  'migrations/0100_projection_refresh_write_amplification.sql',
  'utf8',
);

describe('projection refresh write-amplification migration', () => {
  test('keeps the old rebuild functions as private fallbacks and adds guarded entry points', () => {
    expect(migration).toContain('refresh_player_season_summaries_full_rebuild');
    expect(migration).toContain('refresh_player_state_season_full_rebuild');
    expect(migration).toContain('existing.source_updated_at >= source_time');
    expect(migration).toContain('existing.fpl_source_updated_at >= fpl_source_time');
    expect(migration).toContain('existing.understat_source_updated_at >= understat_source_time');
    expect(migration).toContain('existing.bridge_source_updated_at >= bridge_source_time');
  });

  test('uses a candidate set and null-safe diff for summary rows', () => {
    expect(migration).toContain('player_season_summary_candidates');
    expect(migration).toContain('ON CONFLICT (season_id, element_id) DO UPDATE SET');
    expect(migration).toContain('IS DISTINCT FROM ROW(');
    expect(migration).toContain('DELETE FROM reporting.player_season_summary_rows existing_row');
    expect(migration).not.toContain(
      'DELETE FROM reporting.player_season_summary_rows\n  WHERE season_id = requested_season_id',
    );
  });

  test('uses the same candidate and diff path for Player State and FPL totals', () => {
    expect(migration).toContain('player_state_season_candidates');
    expect(migration).toContain('INSERT INTO reporting.player_state_season_rows AS existing_row');
    expect(migration).toContain('fpl_total_points');
    expect(migration).toContain('fpl_starts');
    expect(migration).toContain('fpl_clean_sheets');
    expect(migration).toContain('fpl_saves');
    expect(migration).toContain('DELETE FROM reporting.player_state_season_rows existing_row');
    expect(migration).not.toContain(
      'DELETE FROM reporting.player_state_season_rows\n  WHERE season_id = requested_season_id',
    );
  });

  test('keeps explicit writer-only execution privileges', () => {
    expect(migration).toContain(
      'REVOKE EXECUTE ON FUNCTION reporting.refresh_player_season_summaries(smallint) FROM PUBLIC',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION reporting.refresh_player_state_season(smallint) TO letletme_data_writer',
    );
  });

  test('keeps points result source watermarks separate from durable write time', () => {
    expect(migration).toContain('ADD COLUMN source_updated_at timestamptz');
    expect(migration).toContain('excluded.source_updated_at');
    expect(migration).toContain('updated_at timestamptz');
  });

  test('rebases legacy local result clocks and invalidates on season identity changes', () => {
    expect(migration).toContain('max(entry.rich_synced_at) AS source_checked_at');
    expect(migration).toContain('result.official_match_id IS NULL');
    expect(migration).toContain(
      'state_row.lifecycle_state IS DISTINCT FROM season.lifecycle_state',
    );
  });

  test('preserves the global Player State dataset revision return contract', () => {
    expect(migration).toContain('SELECT metadata.revision');
    expect(migration).toContain('next_revision,');
    expect(migration).toContain(
      'RETURN QUERY SELECT next_revision, refreshed_players, refreshed_understat_players',
    );
  });
});
