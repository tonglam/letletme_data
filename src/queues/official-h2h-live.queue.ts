import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';
import { officialH2hLiveQueueName } from './names';
import type { TournamentSyncJobData } from './tournament-sync.queue';

export { officialH2hLiveQueueName } from './names';

export const officialH2hLiveQueue = new Queue<TournamentSyncJobData>(officialH2hLiveQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
  },
});

export async function closeOfficialH2HLiveQueue(): Promise<void> {
  await officialH2hLiveQueue.close();
}
