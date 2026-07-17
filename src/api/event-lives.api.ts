import { Elysia, t } from 'elysia';

import {
  enqueueEventLiveSummary,
  enqueueEventLivesCacheUpdate,
  enqueueEventLivesDbSync,
} from '../jobs/live-data.jobs';
import { getEventLivesByEventId } from '../services/event-lives.service';

const eventIdParams = t.Object({ eventId: t.Numeric() });

export const eventLivesAPI = new Elysia({ prefix: '/event-lives' })
  .get(
    '/:eventId',
    async ({ params }) => {
      const data = await getEventLivesByEventId(params.eventId);
      return { success: true, data, eventId: params.eventId };
    },
    { params: eventIdParams },
  )
  .post(
    '/sync/:eventId',
    async ({ params, set }) => {
      const job = await enqueueEventLivesDbSync(params.eventId, 'manual');
      set.status = 202;
      return {
        success: true,
        message: `Event live DB sync job enqueued for event ${params.eventId}`,
        jobId: job.id,
        eventId: params.eventId,
      };
    },
    { params: eventIdParams },
  )
  .post(
    '/cache/:eventId',
    async ({ params, set }) => {
      const job = await enqueueEventLivesCacheUpdate(params.eventId, 'manual');
      set.status = 202;
      return {
        success: true,
        message: `Event live cache update job enqueued for event ${params.eventId}`,
        jobId: job.id,
        eventId: params.eventId,
      };
    },
    { params: eventIdParams },
  )
  .post(
    '/summary/:eventId',
    async ({ params, set }) => {
      const job = await enqueueEventLiveSummary(params.eventId, 'manual');
      set.status = 202;
      return {
        success: true,
        message: `Event live summary job enqueued for event ${params.eventId}`,
        jobId: job.id,
        eventId: params.eventId,
      };
    },
    { params: eventIdParams },
  );
