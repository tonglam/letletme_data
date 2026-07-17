import { Elysia, t } from 'elysia';

import {
  enqueueEntryPicksSyncJob,
  enqueueEntryResultsSyncJob,
  enqueueEntryTransfersSyncJob,
} from '../jobs/entry-sync-enqueue';

/**
 * Entry Sync API Routes
 *
 * Entry syncs run through the entry-sync queue (concurrency-capped, throttled,
 * retried) instead of unbounded in-request Promise.allSettled fan-out. Repeat
 * triggers with an identical entry list dedupe via deterministic job IDs.
 */

const entrySyncBodySchema = t.Object({
  entryIds: t.Array(t.Number(), { minItems: 1, maxItems: 100 }),
  eventId: t.Optional(t.Number()),
});

export const entrySyncAPI = new Elysia({ prefix: '/entry-sync' })
  .post(
    '/picks',
    async ({ body, set }) => {
      const job = await enqueueEntryPicksSyncJob('api', {
        entryIds: body.entryIds,
        eventId: body.eventId,
      });
      set.status = 202;
      return { success: true, message: 'Entry picks sync job enqueued', jobId: job.id };
    },
    { body: entrySyncBodySchema },
  )
  .post(
    '/transfers',
    async ({ body, set }) => {
      const job = await enqueueEntryTransfersSyncJob('api', {
        entryIds: body.entryIds,
        eventId: body.eventId,
      });
      set.status = 202;
      return { success: true, message: 'Entry transfers sync job enqueued', jobId: job.id };
    },
    { body: entrySyncBodySchema },
  )
  .post(
    '/results',
    async ({ body, set }) => {
      const job = await enqueueEntryResultsSyncJob('api', {
        entryIds: body.entryIds,
        eventId: body.eventId,
      });
      set.status = 202;
      return { success: true, message: 'Entry results sync job enqueued', jobId: job.id };
    },
    { body: entrySyncBodySchema },
  )
  .post(
    '/all',
    async ({ body, set }) => {
      const options = { entryIds: body.entryIds, eventId: body.eventId };
      const [picks, transfers, results] = await Promise.all([
        enqueueEntryPicksSyncJob('api', options),
        enqueueEntryTransfersSyncJob('api', options),
        enqueueEntryResultsSyncJob('api', options),
      ]);
      set.status = 202;
      return {
        success: true,
        message: 'Entry sync jobs enqueued',
        jobIds: { picks: picks.id, transfers: transfers.id, results: results.id },
      };
    },
    { body: entrySyncBodySchema },
  );
