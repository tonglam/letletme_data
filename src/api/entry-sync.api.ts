import { Elysia, t } from 'elysia';

import {
  syncEntryEventPicks,
  syncEntryEventResults,
  syncEntryEventTransfers,
} from '../services/entries.service';
import { logError } from '../utils/logger';

const entrySyncBodySchema = t.Object({
  entryIds: t.Array(t.Number(), { minItems: 1 }),
  eventId: t.Optional(t.Number()),
});

type EntrySyncHandler = (entryId: number, eventId?: number) => Promise<unknown>;

async function runEntrySync(entryIds: number[], handler: EntrySyncHandler, eventId?: number) {
  const settled = await Promise.allSettled(
    entryIds.map(async (entryId) => {
      try {
        await handler(entryId, eventId);
        return { entryId, ok: true as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logError('Entry sync API error', error, { entryId });
        return { entryId, ok: false as const, error: message };
      }
    }),
  );

  const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : s.reason)) as Array<{
    entryId: number;
    ok: boolean;
    error?: string;
  }>;

  const success = results.filter((r) => r.ok).length;
  const failed = results.length - success;

  return {
    success: failed === 0,
    processed: results.length,
    successCount: success,
    failedCount: failed,
    results,
  };
}

export const entrySyncAPI = new Elysia({ prefix: '/entry-sync' })
  .post(
    '/picks',
    async ({ body }) => runEntrySync(body.entryIds, syncEntryEventPicks, body.eventId),
    { body: entrySyncBodySchema },
  )
  .post(
    '/transfers',
    async ({ body }) => runEntrySync(body.entryIds, syncEntryEventTransfers, body.eventId),
    { body: entrySyncBodySchema },
  )
  .post(
    '/results',
    async ({ body }) => runEntrySync(body.entryIds, syncEntryEventResults, body.eventId),
    { body: entrySyncBodySchema },
  )
  .post(
    '/all',
    async ({ body }) => {
      const [picks, transfers, results] = await Promise.all([
        runEntrySync(body.entryIds, syncEntryEventPicks, body.eventId),
        runEntrySync(body.entryIds, syncEntryEventTransfers, body.eventId),
        runEntrySync(body.entryIds, syncEntryEventResults, body.eventId),
      ]);

      return { picks, transfers, results };
    },
    { body: entrySyncBodySchema },
  );
