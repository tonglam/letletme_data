import { expect, test } from 'bun:test';

const migrationPath = new URL(
  '../../migrations/0001_optimize_player_value_changes.sql',
  import.meta.url,
);

test('uses a bounded previous-snapshot lookup without adding a speculative index', async () => {
  const migration = await Bun.file(migrationPath).text();

  expect(migration).toContain('LEFT JOIN LATERAL');
  expect(migration).toContain('prior.season_id = snapshot.season_id');
  expect(migration).toContain('prior.element_id = snapshot.element_id');
  expect(migration).toContain('prior.snapshot_date < snapshot.snapshot_date');
  expect(migration).toContain('ORDER BY prior.snapshot_date DESC');
  expect(migration).toContain('LIMIT 1');
  expect(migration).toContain('snapshot.price IS DISTINCT FROM previous.price');
  expect(migration).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
});
