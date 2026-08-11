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
    const sqlQuote = String.fromCharCode(39);

    expect(migration).toContain('value_seed_count NOT IN (0, 564)');
    expect(migration).toContain(
      `jsonb_typeof(metadata -> ${sqlQuote}legacy_cache_revision${sqlQuote})`,
    );
    expect(migration).toContain(
      `jsonb_typeof(metadata -> ${sqlQuote}legacy_publication_skip_reason${sqlQuote})`,
    );
    expect(migration).toMatch(/SET snapshot_source = 'value_seed'/);
    expect(migration).toContain(
      `regexp_replace(rule_id, ${sqlQuote}-v[0-9]+$${sqlQuote}, ${sqlQuote}${sqlQuote})`,
    );
    expect(migration).toMatch(/evidence - 'ruleVersion'/);
    expect(migration).toMatch(/jsonb_build_object\('ruleId', regexp_replace\(rule_id/);
    expect(migration).toMatch(/metadata - ARRAY\[\n  'legacy_cache_revision'/);
    expect(migration).toMatch(/normalized_payload \?\| ARRAY\['version'/);
    expect(migration).toContain('normalized_payload = NULL');
    expect(migration).toContain('source_hash = NULL');
    expect(migration).toMatch(/item\.status IN \('completed', 'failed', 'skipped'\)/);
    expect(migration).toContain(
      'non-terminal sync-item payloads still require explicit canonicalization',
    );
    expect(migration).toContain('manifest = jsonb_build_object(');
    expect(migration).toMatch(/count\(\*\)[\s\S]*<> tournament\.total_team_num/);
    expect(migration).toContain('tournament roster cardinality requires explicit repair');
  });

  test('requires one current core publication without rejecting active live scopes', () => {
    expect(migration).toContain('active_current_core_publication_count <> 1');
    expect(migration).toContain('active_core_publication_count <> 1');
    expect(migration).not.toMatch(
      /count\(\*\) FROM ops\.dataset_publications WHERE status = 'active'/,
    );
  });
});
