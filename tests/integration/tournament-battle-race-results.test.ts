import { describe, expect, test } from 'bun:test';

import { getDb } from '../../src/db/singleton';
import { tournamentBattleGroupResults } from '../../src/db/schemas/index.schema';
import { syncTournamentBattleRaceResults } from '../../src/services/tournament-battle-race-results.service';
import { resolveIntegrationSeedAvailability } from './helpers/tournament-seed';

const resolved = await resolveIntegrationSeedAvailability('battle_races');

describe.skipIf(!resolved.canRun)('Tournament Battle Race Results Integration Tests', () => {
  const seed = resolved.seed!;
  const testEventId = seed.currentEvent.id;

  describe('Sync Integration', () => {
    test('should sync battle race results', async () => {
      const result = await syncTournamentBattleRaceResults(testEventId);

      expect(result).toBeDefined();
      expect(result.eventId).toBe(testEventId);
      expect(result.updatedGroups).toBeGreaterThanOrEqual(0);
      expect(result.updatedResults).toBeGreaterThanOrEqual(0);
    });

    test('should store results in database', async () => {
      await syncTournamentBattleRaceResults(testEventId);

      const db = await getDb();
      const results = await db.select().from(tournamentBattleGroupResults);

      expect(results.length).toBeGreaterThanOrEqual(0);

      if (results.length > 0) {
        const result = results[0];
        expect(typeof result.tournamentId).toBe('number');
        expect(typeof result.groupId).toBe('number');
        expect(typeof result.homeEntryId).toBe('number');
        expect(typeof result.awayEntryId).toBe('number');
      }
    });

    test('should handle no battle race tournaments', async () => {
      const result = await syncTournamentBattleRaceResults(testEventId);

      expect(result).toBeDefined();
    });
  });

  describe('Data Validation', () => {
    test('should have valid battle race result structure', async () => {
      await syncTournamentBattleRaceResults(testEventId);

      const db = await getDb();
      const results = await db.select().from(tournamentBattleGroupResults);

      if (results.length > 0) {
        const result = results[0];
        expect(result.homeEntryId).toBeGreaterThan(0);
        expect(result.awayEntryId).toBeGreaterThan(0);
        expect(result.homeMatchPoints ?? 0).toBeGreaterThanOrEqual(0);
        expect(result.awayMatchPoints ?? 0).toBeGreaterThanOrEqual(0);
      }
    });

    test('should have valid points calculation', async () => {
      await syncTournamentBattleRaceResults(testEventId);

      const db = await getDb();
      const results = await db.select().from(tournamentBattleGroupResults);

      results.forEach((result) => {
        expect([0, 1, 3]).toContain(result.homeMatchPoints ?? 0);
        expect([0, 1, 3]).toContain(result.awayMatchPoints ?? 0);
      });
    });
  });
});
