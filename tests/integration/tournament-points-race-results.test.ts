import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { getDb } from '../../src/db/singleton';
import { tournamentPointsGroupResults } from '../../src/db/schemas/index.schema';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { syncTournamentPointsRaceResults } from '../../src/services/tournament-points-race-results.service';
import { getCurrentEvent } from '../../src/services/events.service';

const currentEvent = await getCurrentEvent();
const tournaments = await tournamentInfoRepository.findActive();
const hasSeedData =
  Boolean(currentEvent) && tournaments.some((t) => t.groupMode === 'points_races');

describe.skipIf(!hasSeedData)('Tournament Points Race Results Integration Tests', () => {
  const testEventId = currentEvent!.id;
  let syncedResult: Awaited<ReturnType<typeof syncTournamentPointsRaceResults>>;

  beforeAll(async () => {
    syncedResult = await syncTournamentPointsRaceResults(testEventId);
  });

  describe('Sync Integration', () => {
    test('should sync points race results', async () => {
      expect(syncedResult).toBeDefined();
      expect(syncedResult.eventId).toBe(testEventId);
      expect(syncedResult.updatedGroups).toBeGreaterThanOrEqual(0);
      expect(syncedResult.updatedResults).toBeGreaterThanOrEqual(0);
    });

    test('should store results in database', async () => {
      const db = await getDb();
      const results = await db
        .select()
        .from(tournamentPointsGroupResults)
        .where(eq(tournamentPointsGroupResults.eventId, testEventId));

      expect(results.length).toBeGreaterThanOrEqual(0);

      if (results.length > 0) {
        const result = results[0];
        expect(typeof result.tournamentId).toBe('number');
        expect(typeof result.groupId).toBe('number');
        expect(typeof result.entryId).toBe('number');
        expect(typeof result.eventGroupRank).toBe('number');
        expect(typeof result.eventPoints).toBe('number');
      }
    });
  });

  describe('Data Validation', () => {
    test('should have valid points race structure', async () => {
      const db = await getDb();
      const results = await db
        .select()
        .from(tournamentPointsGroupResults)
        .where(eq(tournamentPointsGroupResults.eventId, testEventId));

      if (results.length > 0) {
        const result = results[0];
        expect(result.eventGroupRank ?? 0).toBeGreaterThan(0);
        expect(result.eventPoints ?? 0).toBeGreaterThanOrEqual(0);
      }
    });

    test('should have unique ranks per group', async () => {
      const db = await getDb();
      const results = await db
        .select()
        .from(tournamentPointsGroupResults)
        .where(eq(tournamentPointsGroupResults.eventId, testEventId));

      // Group by tournament and group ID
      const groups = new Map<string, typeof results>();
      results.forEach((r) => {
        const key = `${r.tournamentId}-${r.groupId}`;
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)!.push(r);
      });

      // Each group should have unique ranks
      groups.forEach((groupResults) => {
        const ranks = groupResults.map((r) => r.eventGroupRank);
        const uniqueRanks = new Set(ranks);
        expect(uniqueRanks.size).toBe(ranks.length);
      });
    });
  });
});
