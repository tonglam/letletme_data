import { beforeAll, describe, expect, test } from 'bun:test';

import { teams } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { syncTeams } from '../../src/services/teams.service';

describe('Teams Integration Tests', () => {
  beforeAll(async () => {
    // Sync teams once
    await syncTeams();
  });

  test('syncTeams persists data to database', async () => {
    const db = await getDb();
    const rows = await db.select({ id: teams.id }).from(teams);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBe(20); // Premier League has 20 teams
  });

  test('should have valid team structure', async () => {
    const db = await getDb();
    const teamRows = await db.select().from(teams).limit(1);
    expect(teamRows.length).toBeGreaterThan(0);

    const team = teamRows[0];
    expect(typeof team.id).toBe('number');
    expect(typeof team.code).toBe('number');
    expect(typeof team.name).toBe('string');
    expect(typeof team.shortName).toBe('string');
    expect(typeof team.strength).toBe('number');
  });

  test('should have teams with valid pulse_id', async () => {
    const db = await getDb();
    const teamRows = await db.select().from(teams);

    teamRows.forEach((team) => {
      expect(team.pulseId).toBeGreaterThan(0);
      expect(typeof team.pulseId).toBe('number');
    });
  });

  test('should have teams with strength ratings', async () => {
    const db = await getDb();
    const teamRows = await db.select().from(teams);

    teamRows.forEach((team) => {
      expect(team.strength).toBeGreaterThan(0);
      expect(team.strengthOverallHome).toBeGreaterThan(0);
      expect(team.strengthOverallAway).toBeGreaterThan(0);
      expect(team.strengthAttackHome).toBeGreaterThan(0);
      expect(team.strengthAttackAway).toBeGreaterThan(0);
      expect(team.strengthDefenceHome).toBeGreaterThan(0);
      expect(team.strengthDefenceAway).toBeGreaterThan(0);
    });
  });

  test('should have created_at and updated_at timestamps', async () => {
    const db = await getDb();
    const teamRows = await db.select().from(teams).limit(3);

    teamRows.forEach((team) => {
      expect(team.createdAt).toBeDefined();
      expect(team.updatedAt).toBeDefined();
      expect(team.createdAt).toBeInstanceOf(Date);
      expect(team.updatedAt).toBeInstanceOf(Date);
    });
  });

  test('should update updated_at on re-sync', async () => {
    const db = await getDb();

    // Get initial timestamps
    const before = await db.select().from(teams).limit(1);
    const beforeUpdatedAt = before[0].updatedAt;

    // Wait a moment to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Re-sync teams
    await syncTeams();

    // Get new timestamps
    const after = await db.select().from(teams).limit(1);
    const afterUpdatedAt = after[0].updatedAt;

    // created_at should remain unchanged, updated_at should change
    expect(after[0].createdAt).toEqual(before[0].createdAt);
    expect(afterUpdatedAt?.getTime()).toBeGreaterThan(beforeUpdatedAt?.getTime() || 0);
  });
});
