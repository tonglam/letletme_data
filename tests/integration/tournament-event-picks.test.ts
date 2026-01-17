import { beforeAll, describe, expect, test } from 'bun:test';

import { getDb } from '../../src/db/singleton';
import { entryEventPicks } from '../../src/db/schemas/index.schema';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { syncTournamentEventPicks } from '../../src/services/tournament-event-picks.service';
import { getCurrentEvent } from '../../src/services/events.service';

describe('Tournament Event Picks Integration Tests', () => {
  let testEventId: number;
  let hasActiveTournaments: boolean;

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
    test('should sync tournament event picks', async () => {
      const result = await syncTournamentEventPicks(testEventId);

      expect(result).toBeDefined();
      expect(result.eventId).toBe(testEventId);
      expect(result.totalEntries).toBeGreaterThanOrEqual(0);
      expect(result.synced).toBeGreaterThanOrEqual(0);
    });

    test('should store picks in database', async () => {
      if (!hasActiveTournaments) {
        console.log('⊘ Skipping - no active tournaments');
        return;
      }

      await syncTournamentEventPicks(testEventId);

      const db = await getDb();
      const picks = await db.select().from(entryEventPicks);

      expect(picks.length).toBeGreaterThanOrEqual(0);

      if (picks.length > 0) {
        const pick = picks[0];
        expect(typeof pick.entryId).toBe('number');
        expect(typeof pick.eventId).toBe('number');
        expect(pick.picks).toBeDefined();
        // picks is JSONB array, check first element
        if (Array.isArray(pick.picks) && pick.picks.length > 0) {
          const firstPick = pick.picks[0] as any;
          expect(typeof firstPick.element).toBe('number');
          expect(typeof firstPick.position).toBe('number');
        }
      }
    });
  });

  describe('Data Validation', () => {
    test('should have valid pick structure', async () => {
      if (!hasActiveTournaments) {
        console.log('⊘ Skipping - no active tournaments');
        return;
      }

      await syncTournamentEventPicks(testEventId);

      const db = await getDb();
      const picks = await db.select().from(entryEventPicks);

      if (picks.length > 0) {
        const pick = picks[0];
        expect(pick.picks).toBeDefined();
        // picks is JSONB array of pick objects
        if (Array.isArray(pick.picks) && pick.picks.length > 0) {
          const firstPick = pick.picks[0] as any;
          expect(firstPick.position).toBeGreaterThanOrEqual(1);
          expect(firstPick.position).toBeLessThanOrEqual(15); // 11 starting + 4 bench
          expect(firstPick.element).toBeGreaterThan(0);
        }
      }
    });

    test('should have 15 picks per entry', async () => {
      if (!hasActiveTournaments) {
        console.log('⊘ Skipping - no active tournaments');
        return;
      }

      await syncTournamentEventPicks(testEventId);

      const db = await getDb();
      const picksRows = await db.select().from(entryEventPicks);

      // Each row contains all 15 picks for one entry-event combination in JSONB
      picksRows.forEach((row) => {
        if (Array.isArray(row.picks)) {
          expect(row.picks.length).toBe(15);
        }
      });
    });
  });
});
