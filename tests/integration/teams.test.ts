import { beforeEach, describe, expect, test } from 'bun:test';

import { getDb } from '../../src/db/singleton';
import { teams } from '../../src/db/schemas/index.schema';
import { teamRepository } from '../../src/repositories/teams';
import { clearTeamsCache, syncTeams } from '../../src/services/teams.service';

describe('Teams Integration Tests', () => {
  beforeEach(async () => {
    await teamRepository.deleteAll();
    await clearTeamsCache();
  });

  test('syncTeams persists data to database', async () => {
    const result = await syncTeams();
    expect(result.count).toBeGreaterThan(0);

    const db = await getDb();
    const rows = await db.select({ id: teams.id }).from(teams);
    expect(rows.length).toBe(result.count);
  });

  test('clearTeamsCache completes after sync', async () => {
    await syncTeams();
    await expect(clearTeamsCache()).resolves.toBeUndefined();
  });
});
