import { describe, expect, test } from 'bun:test';

const migration = await Bun.file('migrations/0095_canonicalize_platform_contract.sql').text();

describe('canonical platform contract migration', () => {
  test('rewrites the complete versioned Data namespace exactly once', () => {
    expect(migration).toMatch(/\^llm:v\[0-9\]\+:data:/);
    expect(migration).toContain('llm:data:');
    expect(migration).not.toContain('^llm:[^:]+:');
    expect(migration).toMatch(/coalesce\(item ->> 'key', ''\) !~ '\^llm:v\[0-9\]\+:data:'/);
    expect(migration).toMatch(/coalesce\(item ->> 'key', ''\) !~ '\^llm:data:'/);
  });

  test('bounds every additional application-data normalization', () => {
    expect(migration).toContain('value_seed_count NOT IN (0, 564)');
    expect(migration).toMatch(/SET snapshot_source = 'value_seed'/);
    expect(migration).toMatch(/SET rule_id = 'understat-fpl-player-name'/);
    expect(migration).toContain('manifest = jsonb_build_object(');
  });
});
