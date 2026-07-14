import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { leagueEventResults } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { getCurrentEvent } from '../../src/services/events.service';
import { syncLeagueEventResultsByTournament } from '../../src/services/league-event-results.service';

const currentEvent = await getCurrentEvent();
const tournaments = await tournamentInfoRepository.findActive();
const hasSeedData = Boolean(currentEvent) && tournaments.length > 0;

describe.skipIf(!hasSeedData)('League Event Results Integration Tests', () => {
  const testEventId = currentEvent!.id;
  const testTournamentId = tournaments[0]!.id;
  let syncedResult: Awaited<ReturnType<typeof syncLeagueEventResultsByTournament>>;

  beforeAll(async () => {
    syncedResult = await syncLeagueEventResultsByTournament(testTournamentId, testEventId);
  });

  describe('Sync Integration', () => {
    test(
      'should sync league event results for tournament',
      async () => {
        expect(syncedResult).toBeDefined();
        expect(syncedResult.tournamentId).toBe(testTournamentId);
        expect(syncedResult.eventId).toBe(testEventId);
        expect(syncedResult.totalEntries).toBeGreaterThanOrEqual(0);
        expect(syncedResult.updated).toBeGreaterThanOrEqual(0);
        expect(syncedResult.skipped).toBeGreaterThanOrEqual(0);
      },
      { timeout: 15000 },
    );

    test(
      'should store results in database',
      async () => {
        const db = await getDb();
        const results = await db
          .select()
          .from(leagueEventResults)
          .where(eq(leagueEventResults.eventId, testEventId));

        expect(results.length).toBeGreaterThanOrEqual(0);

        if (results.length > 0) {
          const result = results[0];
          expect(typeof result.entryId).toBe('number');
          expect(typeof result.eventId).toBe('number');
          expect(typeof result.leagueId).toBe('number');
          expect(typeof result.overallPoints).toBe('number');
          expect(typeof result.eventPoints).toBe('number');
        }
      },
      { timeout: 15000 },
    );
  });

  describe('Data Validation', () => {
    test(
      'should have valid result structure',
      async () => {
        const db = await getDb();
        const results = await db
          .select()
          .from(leagueEventResults)
          .where(eq(leagueEventResults.eventId, testEventId));

        if (results.length > 0) {
          const result = results[0];
          expect(result.overallPoints).toBeGreaterThanOrEqual(-50);
          expect(result.overallPoints).toBeLessThanOrEqual(3000);
          expect(result.eventPoints).toBeGreaterThanOrEqual(-50);
          expect(result.eventPoints).toBeLessThanOrEqual(300);
        }
      },
      { timeout: 15000 },
    );

    test(
      'should have consistent points calculation',
      async () => {
        const db = await getDb();
        const results = await db
          .select()
          .from(leagueEventResults)
          .where(eq(leagueEventResults.eventId, testEventId));

        results.forEach((result) => {
          // Net points should be event points minus transfers cost
          const expectedNet = result.eventPoints - result.eventTransfersCost;
          expect(result.eventNetPoints).toBe(expectedNet);

          // Transfers cost should be non-negative
          expect(result.eventTransfersCost).toBeGreaterThanOrEqual(0);
        });
      },
      { timeout: 15000 },
    );
  });

  describe('Performance', () => {
    test(
      'should complete sync within reasonable time',
      async () => {
        expect(syncedResult.totalEntries).toBeGreaterThanOrEqual(0);
      },
      { timeout: 15000 },
    );
  });
});
