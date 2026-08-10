import { Elysia } from 'elysia';

import { enqueueCoreSnapshotJob } from '../jobs/data-sync-enqueue';
import { seasonRepository } from '../repositories/seasons';

/**
 * Teams API Routes
 *
 * Handles all team-related HTTP endpoints:
 * - POST /teams/sync - Trigger teams sync
 */

export const teamsAPI = new Elysia({ prefix: '/teams' }).post('/sync', async ({ set }) => {
  const season = await seasonRepository.findCurrent();
  const job = await enqueueCoreSnapshotJob(season, 'api');
  if (job.id === undefined) throw new Error('Teams sync queue did not assign a job ID');
  set.status = 202;
  return {
    success: true,
    status: 'queued' as const,
    jobId: String(job.id),
    message: 'Core snapshot queued',
  };
});
