import { Elysia } from 'elysia';

import { enqueueTeamsSyncJob } from '../jobs/data-sync-enqueue';

/**
 * Teams API Routes
 *
 * Handles all team-related HTTP endpoints:
 * - POST /teams/sync - Trigger teams sync
 */

export const teamsAPI = new Elysia({ prefix: '/teams' }).post('/sync', async ({ set }) => {
  const job = await enqueueTeamsSyncJob('api');
  if (job.id === undefined) throw new Error('Teams sync queue did not assign a job ID');
  set.status = 202;
  return {
    success: true,
    status: 'queued' as const,
    jobId: String(job.id),
    message: 'Teams sync queued',
  };
});
