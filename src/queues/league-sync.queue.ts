import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import type { LeagueSyncJobData } from './league-sync-job-contract';
import { leagueSyncQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

export { leagueSyncQueueName } from './names';

export {
  INVALID_LEAGUE_SYNC_JOB_CODE,
  InvalidLeagueSyncJobError,
  isLeagueSyncJobName,
  LEAGUE_JOBS,
  LeagueSyncJobDataSchema,
  parseLeagueSyncJobData,
  validateLeagueSyncJobData,
} from './league-sync-job-contract';
export type { LeagueSyncJobData, LeagueSyncJobName } from './league-sync-job-contract';

export const leagueSyncQueue = new Queue<LeagueSyncJobData>(leagueSyncQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60_000, // 1 minute
    },
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
  },
});

export async function closeLeagueSyncQueue() {
  await leagueSyncQueue.close();
}
