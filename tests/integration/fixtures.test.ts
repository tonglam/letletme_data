import { beforeAll, describe, expect, test } from 'bun:test';

import { eventFixtures } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { syncAllGameweeks, syncFixtures } from '../../src/services/fixtures.service';

describe('Fixtures Integration Tests', () => {
  beforeAll(async () => {
    // Sync fixtures once
    await syncFixtures();
  });

  test('syncFixtures persists data to database', async () => {
    const db = await getDb();
    const rows = await db.select({ id: eventFixtures.id }).from(eventFixtures);
    expect(rows.length).toBeGreaterThan(0);
  });

  test('should have valid fixture structure', async () => {
    const db = await getDb();
    const fixtures = await db.select().from(eventFixtures).limit(1);
    expect(fixtures.length).toBeGreaterThan(0);

    const fixture = fixtures[0];
    expect(typeof fixture.id).toBe('number');
    expect(typeof fixture.code).toBe('number');
    expect(typeof fixture.finished).toBe('boolean');
    expect(typeof fixture.kickoffTime).toBe('object'); // Date or null
  });

  test('should have fixtures with event assignment', async () => {
    const db = await getDb();
    const fixtures = await db.select().from(eventFixtures).limit(5);

    expect(fixtures.length).toBeGreaterThan(0);
    
    // Some fixtures may not be assigned to an event yet
    const assignedFixtures = fixtures.filter((f) => f.event !== null);
    expect(assignedFixtures.length).toBeGreaterThan(0);
  });

  test.skip('syncAllGameweeks returns summary for each event', async () => {
    // Skip: Long-running operation, tested in production
    const summary = await syncAllGameweeks();
    expect(summary.totalCount).toBeGreaterThan(0);
    expect(summary.perGameweek.length).toBeGreaterThan(0);
  });
});
