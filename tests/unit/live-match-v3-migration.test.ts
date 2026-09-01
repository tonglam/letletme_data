import { describe, expect, test } from 'bun:test';

const migration = await Bun.file('migrations/0076_live_matches_v2_checkpoints.sql').text();
const v3Fence = await Bun.file('migrations/0083_live_matches_v3_contract_fence.sql').text();

describe('Live Matches V3 checkpoint migration contract', () => {
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

  test('destructively purges pre-cutover rows and fences both tables to V3', () => {
    expect(v3Fence.match(/ADD COLUMN contract_version text;/g)).toHaveLength(2);
    expect(
      v3Fence.match(/WHERE contract_version IS DISTINCT FROM 'live-matches-v3';/g),
    ).toHaveLength(2);
    expect(
      v3Fence.match(/ALTER COLUMN contract_version SET DEFAULT 'live-matches-v3'/g),
    ).toHaveLength(2);
    expect(v3Fence).toContain(
      `contract_version = manifest ->> ${String.fromCharCode(39)}contractVersion${String.fromCharCode(39)}`,
    );
    expect(v3Fence).not.toContain('live-matches-v2');
    expect(v3Fence).toContain('pre-cutover database');
    expect(v3Fence).toContain('live_match_desk_checkpoints_contract_fence');
    expect(v3Fence).toContain('live_match_detail_checkpoints_contract_fence');
    expect(
      v3Fence.match(
        /contract_version = manifest ->> 'contractVersion'\n    AND contract_version = 'live-matches-v3'/g,
      ),
    ).toHaveLength(2);
  });
});
