import { describe, expect, test } from 'bun:test';

const migration = await Bun.file('migrations/0076_live_matches_v2_checkpoints.sql').text();

describe('Live Matches V2 checkpoint migration contract', () => {
  test('stores self-contained bounded manifests and payloads', () => {
    expect(migration).toContain('manifest jsonb NOT NULL');
    expect(migration).toMatch(/jsonb_typeof\(manifest\) = 'object'/);
    expect(migration).toContain('pg_column_size(manifest) <= 131072');
    expect(migration).toContain('payload_bytes BETWEEN 0 AND 2097152');
    expect(migration).toContain('checkpointed_at timestamptz NOT NULL');
  });

  test('grants the GraphQL reader exact SELECT with RLS policies on both tables', () => {
    for (const table of ['live_match_desk_checkpoints', 'live_match_detail_checkpoints']) {
      expect(migration).toContain(`GRANT SELECT ON TABLE fpl.${table} TO letletme_graphql_reader`);
      expect(migration).toContain(`ALTER TABLE fpl.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`${table}_graphql_reader_select`);
      expect(migration).toContain(`ON fpl.${table}\n  FOR SELECT TO letletme_graphql_reader`);
    }
  });
});
