import { Elysia } from 'elysia';

import { enqueuePhasesSyncJob } from '../jobs/data-sync-enqueue';

/**
 * Phases API Routes
 *
 * Handles all phase-related HTTP endpoints:
 * - POST /phases/sync - Trigger phases sync
 */

export const phasesAPI = new Elysia({ prefix: '/phases' }).post('/sync', async ({ set }) => {
  const job = await enqueuePhasesSyncJob('api');
  if (job.id === undefined) throw new Error('Phases sync queue did not assign a job ID');
  set.status = 202;
  return {
    success: true,
    status: 'queued' as const,
    jobId: String(job.id),
    message: 'Phases sync queued',
  };
});
