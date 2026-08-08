import { Elysia, t } from 'elysia';

import {
  enqueueEntryPicksSyncJob,
  enqueueEntryResultsSyncJob,
  enqueueEntryTransfersSyncJob,
} from '../jobs/entry-sync-enqueue';
import { seasonRepository } from '../repositories/seasons';

/**
 * Entry Sync API Routes
 *
 * Entry syncs run through the entry-sync queue (concurrency-capped, throttled,
 * retried) instead of unbounded in-request Promise.allSettled fan-out. Repeat
 * triggers with an identical entry list dedupe via deterministic job IDs.
 */

const positiveInteger = t.Number({ minimum: 1, multipleOf: 1 });
const entrySyncBodySchema = t.Object({
  entryIds: t.Array(positiveInteger, { minItems: 1, maxItems: 100 }),
  eventId: t.Optional(positiveInteger),
});

export const entrySyncAPI = new Elysia({ prefix: '/entry-sync' })
  .post(
    '/picks',
    async ({ body, set }) => {
      const season = await seasonRepository.findCurrent();
      const job = await enqueueEntryPicksSyncJob(season, 'api', {
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
      const season = await seasonRepository.findCurrent();
      const job = await enqueueEntryTransfersSyncJob(season, 'api', {
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
      const season = await seasonRepository.findCurrent();
      const job = await enqueueEntryResultsSyncJob(season, 'api', {
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
      const season = await seasonRepository.findCurrent();
      const options = { entryIds: body.entryIds, eventId: body.eventId };
      const [picks, transfers, results] = await Promise.all([
        enqueueEntryPicksSyncJob(season, 'api', options),
        enqueueEntryTransfersSyncJob(season, 'api', options),
        enqueueEntryResultsSyncJob(season, 'api', options),
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
