import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const migration = readFileSync(
  'migrations/0103_gw3_performance_telemetry_and_freshness_indexes.sql',
  'utf8',
);
const opsSchema = readFileSync('src/db/schemas/platform/ops.schema.ts', 'utf8');
const fplSchema = readFileSync('src/db/schemas/platform/fpl.schema.ts', 'utf8');
const reportingSchema = readFileSync('src/db/schemas/platform/reporting.schema.ts', 'utf8');

describe('GW3 telemetry and freshness migration contract', () => {
  test('keeps v2 storage additive and isolated from legacy samples', () => {
    expect(migration).toContain('CREATE TABLE ops.client_signal_v2_batches');
    expect(migration).toContain('CREATE TABLE ops.client_signal_v2_windows');
    expect(migration).toContain('client_release');
    expect(migration).toContain('ingest_release');
    expect(migration).toContain('estimated_count');
    expect(migration).toContain('occurrence_count');
    expect(migration).toContain('first_observed_at');
    expect(migration).toContain('last_observed_at');
    expect(migration).toContain('NULLS NOT DISTINCT');
    expect(migration).toContain(
      'REVOKE ALL ON TABLE ops.client_signal_v2_windows FROM letletme_graphql_reader',
    );
    expect(migration).toContain(
      'ALTER TABLE ops.client_signal_v2_batches ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE ops.client_signal_v2_windows ENABLE ROW LEVEL SECURITY',
    );
    expect(opsSchema).toContain('client_signal_v2_windows');
  });

  test('declares both freshness indexes in Drizzle and SQL', () => {
    for (const name of [
      'player_gameweek_stats_season_updated_idx',
      'player_season_summary_rows_season_source_updated_idx',
    ]) {
      expect(migration).toContain(name);
      expect(fplSchema + reportingSchema).toContain(name);
    }
  });
});
