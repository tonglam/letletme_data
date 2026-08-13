import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { PLAYER_SEASON_SUMMARY_REPAIR_SCHEDULE } from '../../src/jobs/player-season-summary.jobs';

const migration = readFileSync('migrations/0005_player_season_summary_rows.sql', 'utf8');

describe('player season summary read model', () => {
  test('publishes a physical per-season table behind the compatibility view', () => {
    expect(migration).toContain('CREATE TABLE reporting.player_season_summary_rows');
    expect(migration).toContain('CONSTRAINT player_season_summary_rows_pkey');
    expect(migration).toContain('count(*) FILTER (WHERE stats.total_points >= 5)');
    expect(migration).toContain('CREATE VIEW reporting.player_season_summaries');
    expect(migration).toContain('FROM reporting.player_season_summary_rows');
  });

  test('tracks revisions and refreshes one season under a transaction lock', () => {
    expect(migration).toContain('CREATE TABLE reporting.player_season_summary_refreshes');
    expect(migration).toContain('reporting.refresh_player_season_summaries');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain(
      'revision = reporting.player_season_summary_refreshes.revision + 1',
    );
    expect(PLAYER_SEASON_SUMMARY_REPAIR_SCHEDULE).toBe('17 * * * *');
  });

  test('keeps runtime write and GraphQL read privileges explicit', () => {
    expect(migration).toContain('TO letletme_data_writer');
    expect(migration).toContain('TO letletme_graphql_reader');
  });
});
