import { Elysia, t } from 'elysia';
import { enqueueEntryInfoSyncJob } from '../jobs/entry-sync-enqueue';
import { seasonRepository } from '../repositories/seasons';

export const entryInfoAPI = new Elysia({ prefix: '/entry-info' }).post(
  '/:entryId/sync',
  async ({ params, set }) => {
    const season = await seasonRepository.findCurrent();
    const job = await enqueueEntryInfoSyncJob(season, 'api', {
      entryIds: [params.entryId],
    });
    if (job.id === undefined) throw new Error('Entry info queue did not assign a job ID');
    set.status = 202;
    return {
      success: true,
      status: 'queued' as const,
      jobId: String(job.id),
      message: 'Entry info sync queued',
    };
  },
  {
    params: t.Object({ entryId: t.Number({ minimum: 1, multipleOf: 1 }) }),
  },
);
