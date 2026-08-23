import { Elysia, t } from 'elysia';
import { enqueueEntryOnboarding } from '../jobs/maintenance.jobs';
import { seasonRepository } from '../repositories/seasons';
import { getCurrentEvent } from '../services/events.service';

export const entryInfoAPI = new Elysia({ prefix: '/entry-info' }).post(
  '/:entryId/sync',
  async ({ params, set }) => {
    const season = await seasonRepository.findCurrent();
    const currentEvent = await getCurrentEvent(season);
    const job = await enqueueEntryOnboarding(season, 'api', {
      entryId: params.entryId,
      ...(currentEvent ? { eventId: currentEvent.id } : {}),
    });
    if (job.id === undefined) throw new Error('Entry onboarding queue did not assign a job ID');
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
