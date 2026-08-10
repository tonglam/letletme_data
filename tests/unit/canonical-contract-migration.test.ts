import { describe, expect, test } from 'bun:test';

const migration = await Bun.file('migrations/0095_canonicalize_platform_contract.sql').text();

describe('canonical platform contract migration', () => {
  test('rewrites the complete retired Data namespace exactly once', () => {
    expect(migration).toMatch(/\^llm:v\[0-9\]\+:data:/);
    expect(migration).toContain('llm:data:');
    expect(migration).not.toContain('^llm:[^:]+:');
    expect(migration).toMatch(/coalesce\(item ->> 'key', ''\) !~ '\^llm:v\[0-9\]\+:data:'/);
    expect(migration).toMatch(/coalesce\(item ->> 'key', ''\) !~ '\^llm:data:'/);
  });

  test('bounds every additional application-data normalization', () => {
    expect(migration).toContain('value_seed_count NOT IN (0, 564)');
    expect(migration).toContain('cache_metadata_count NOT IN (0, 27)');
    expect(migration).toContain('publication_skip_metadata_count NOT IN (0, 4)');
    expect(migration).toMatch(/SET snapshot_source = 'value_seed'/);
    expect(migration).toMatch(/SET\s+rule_id = 'understat-fpl-player-name'/);
    expect(migration).toMatch(/evidence - 'ruleVersion'/);
    expect(migration).toMatch(/jsonb_build_object\('ruleId', 'understat-fpl-player-name'\)/);
    expect(migration).toMatch(/metadata - ARRAY\[\n  'legacy_cache_revision'/);
    expect(migration).toMatch(/normalized_payload \?\| ARRAY\['version'/);
    expect(migration).toContain('manifest = jsonb_build_object(');
  });
});
