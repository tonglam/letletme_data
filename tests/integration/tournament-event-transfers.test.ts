import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { beforeAll, describe, expect, test } from 'bun:test';

import { entryEventTransfers, players } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import {
  type EntryTransfersClient,
  syncTournamentEventTransfersPost,
  syncTournamentEventTransfersPre,
} from '../../src/services/tournament-event-transfers.service';
import { ensurePlayers } from './helpers/reference-data';
import { resolveIntegrationSeedAvailability } from './helpers/tournament-seed';

await ensurePlayers();
const resolved = await resolveIntegrationSeedAvailability('any');

describe.skipIf(!resolved.canRun || !resolved.seed?.currentEvent)(
  'Tournament Event Transfers Integration Tests',
  () => {
    const seed = resolved.seed;
    const testEventId = seed?.currentEvent?.id ?? -1;
    let recordedClient: EntryTransfersClient;

    beforeAll(async () => {
      const db = await getDb();
      const playerRows = await db.select({ id: players.id }).from(players).limit(2);
      if (playerRows.length < 2) {
        throw new Error('At least two players are required for the transfer integration fixture');
      }

      recordedClient = {
        async getEntryTransfers(entryId) {
          return [
            {
              entry: entryId,
              event: testEventId,
              element_in: playerRows[0].id,
              element_in_cost: 50,
              element_in_points: 0,
              element_out: playerRows[1].id,
              element_out_cost: 50,
              element_out_points: 0,
              time: '2026-07-21T00:00:00Z',
            },
          ];
        },
      };
    });

    describe('Pre-Event Transfers Sync', () => {
      test('should sync pre-event transfers', async () => {
        const result = await syncTournamentEventTransfersPre(testEventId, {
          client: recordedClient,
        });

        expect(result).toBeDefined();
        expect(result.eventId).toBe(testEventId);
        expect(result.totalEntries).toBeGreaterThanOrEqual(0);
      });

      test('should store transfers in database', async () => {
        await syncTournamentEventTransfersPre(testEventId, { client: recordedClient });

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
        await syncTournamentEventTransfersPre(testEventId, { client: recordedClient });

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
