import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import {
  MANAGER_LIVE_ATTEMPTS,
  MANAGER_LIVE_RETRY_BASE_DELAY_MS,
} from '../domain/manager-live-refresh';
import { managerLiveQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

export { managerLiveQueueName } from './names';

export const MANAGER_LIVE_JOB_VERSION = 1 as const;

export const MANAGER_LIVE_JOBS = {
  REFRESH: 'manager-live-refresh',
} as const;

export interface ManagerLiveJobData {
  version: typeof MANAGER_LIVE_JOB_VERSION;
  seasonId: number;
  seasonCode: string;
  eventId: number;
  entryIds: number[];
  tournamentId?: number;
  source: 'request' | 'followup';
  triggeredAt: string;
}

export const managerLiveQueue = new Queue<ManagerLiveJobData>(managerLiveQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    // One initial attempt plus 30/60/120 second retries.
    attempts: MANAGER_LIVE_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: MANAGER_LIVE_RETRY_BASE_DELAY_MS,
    },
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
  },
});

export async function closeManagerLiveQueue(): Promise<void> {
  await managerLiveQueue.close();
}
