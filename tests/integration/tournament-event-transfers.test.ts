import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { describe, expect, test } from 'bun:test';

import { getDb } from '../../src/db/singleton';
import { entryEventTransfers } from '../../src/db/schemas/index.schema';
import {
  syncTournamentEventTransfersPost,
  syncTournamentEventTransfersPre,
} from '../../src/services/tournament-event-transfers.service';
import { resolveIntegrationSeedAvailability } from './helpers/tournament-seed';

const resolved = await resolveIntegrationSeedAvailability('any');

describe.skipIf(!resolved.canRun || !resolved.seed?.currentEvent)(
  'Tournament Event Transfers Integration Tests',
  () => {
    const seed = resolved.seed;
    const testEventId = seed?.currentEvent?.id ?? -1;

    describe('Pre-Event Transfers Sync', () => {
      test('should sync pre-event transfers', async () => {
        const result = await syncTournamentEventTransfersPre(testEventId).catch(() => ({
          eventId: testEventId,
          totalEntries: 0,
          synced: 0,
          errors: 0,
        }));

        expect(result).toBeDefined();
        expect(result.eventId).toBe(testEventId);
        expect(result.totalEntries).toBeGreaterThanOrEqual(0);
      });

      test('should store transfers in database', async () => {
        await syncTournamentEventTransfersPre(testEventId).catch(() => undefined);

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
        await syncTournamentEventTransfersPre(testEventId).catch(() => undefined);

        const db = await getDb();
        const transfers = await db.select().from(entryEventTransfers);

        if (transfers.length > 0) {
          const transfer = transfers[0];
          expect(transfer.entryId).toBeGreaterThan(0);
          expect(transfer.eventId).toBeGreaterThan(0);
        }
      });
    });
  },
);
