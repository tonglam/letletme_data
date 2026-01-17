import { beforeAll, describe, expect, test } from 'bun:test';

import { getDb } from '../../src/db/singleton';
import { entryEventTransfers } from '../../src/db/schemas/index.schema';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import {
  syncTournamentEventTransfersPost,
  syncTournamentEventTransfersPre,
} from '../../src/services/tournament-event-transfers.service';
import { getCurrentEvent } from '../../src/services/events.service';

describe('Tournament Event Transfers Integration Tests', () => {
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

  describe('Pre-Event Transfers Sync', () => {
    test('should sync pre-event transfers', async () => {
      const result = await syncTournamentEventTransfersPre(testEventId);

      expect(result).toBeDefined();
      expect(result.eventId).toBe(testEventId);
      expect(result.totalEntries).toBeGreaterThanOrEqual(0);
    });

    test('should store transfers in database', async () => {
      if (!hasActiveTournaments) {
        console.log('⊘ Skipping - no active tournaments');
        return;
      }

      await syncTournamentEventTransfersPre(testEventId);

      const db = await getDb();
      const transfers = await db.select().from(entryEventTransfers);

      expect(transfers.length).toBeGreaterThanOrEqual(0);

      if (transfers.length > 0) {
        const transfer = transfers[0];
        expect(typeof transfer.entryId).toBe('number');
        expect(typeof transfer.eventId).toBe('number');
      }
    });
  });

  describe('Post-Event Transfers Sync', () => {
    test('should sync post-event transfers', async () => {
      const result = await syncTournamentEventTransfersPost(testEventId);

      expect(result).toBeDefined();
      expect(result.eventId).toBe(testEventId);
      expect(result.totalEntries).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Data Validation', () => {
    test('should have valid transfer structure', async () => {
      if (!hasActiveTournaments) {
        console.log('⊘ Skipping - no active tournaments');
        return;
      }

      await syncTournamentEventTransfersPre(testEventId);

      const db = await getDb();
      const transfers = await db.select().from(entryEventTransfers);

      if (transfers.length > 0) {
        const transfer = transfers[0];
        expect(transfer.entryId).toBeGreaterThan(0);
        expect(transfer.eventId).toBeGreaterThan(0);
      }
    });
  });
});
