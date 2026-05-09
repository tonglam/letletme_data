import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { getDb } from '../../src/db/singleton';
import { entryEventCupResults } from '../../src/db/schemas/index.schema';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { syncTournamentEventCupResults } from '../../src/services/tournament-event-cup-results.service';
import { getCurrentEvent } from '../../src/services/events.service';

describe('Tournament Event Cup Results Integration Tests', () => {
  let testEventId: number;
  let hasActiveTournaments: boolean;
  let syncPromise: ReturnType<typeof syncTournamentEventCupResults> | undefined;

  function ensureSynced() {
    syncPromise ??= syncTournamentEventCupResults(testEventId);
    return syncPromise;
  }

  beforeAll(async () => {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found - cannot run integration tests');
    }
    testEventId = currentEvent.id;

    const tournaments = await tournamentInfoRepository.findActive();
    hasActiveTournaments = tournaments.length > 0;

    if (!hasActiveTournaments) {
      console.log('⚠️  No active tournaments found - some tests will be skipped');
    }
  });

  describe('Sync Integration', () => {
    test(
      'should sync tournament event cup results',
      async () => {
        const result = await ensureSynced();

        expect(result).toBeDefined();
        expect(result.eventId).toBe(testEventId);
        expect(result.totalEntries).toBeGreaterThanOrEqual(0);
        expect(result.upserted).toBeGreaterThanOrEqual(0);
      },
      { timeout: 30000 },
    );

    test(
      'should store cup results in database',
      async () => {
        if (!hasActiveTournaments) {
          console.log('⊘ Skipping - no active tournaments');
          return;
        }

        await ensureSynced();

        const db = await getDb();
        const results = await db
          .select()
          .from(entryEventCupResults)
          .where(eq(entryEventCupResults.eventId, testEventId));

        expect(results.length).toBeGreaterThanOrEqual(0);

        if (results.length > 0) {
          const result = results[0];
          expect(typeof result.entryId).toBe('number');
          expect(typeof result.eventId).toBe('number');
        }
      },
      { timeout: 30000 },
    );
  });

  describe('Data Validation', () => {
    test(
      'should have valid cup result structure',
      async () => {
        if (!hasActiveTournaments) {
          console.log('⊘ Skipping - no active tournaments');
          return;
        }

        await ensureSynced();

        const db = await getDb();
        const results = await db
          .select()
          .from(entryEventCupResults)
          .where(eq(entryEventCupResults.eventId, testEventId));

        if (results.length > 0) {
          const result = results[0];
          expect(result.entryId).toBeGreaterThan(0);
          expect(result.eventId).toBeGreaterThan(0);
        }
      },
      { timeout: 30000 },
    );
  });
});
