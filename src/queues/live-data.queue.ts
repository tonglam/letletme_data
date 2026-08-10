import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { liveDataQueueName } from './names';

export { liveDataQueueName } from './names';

export const LIVE_JOBS = {
  LIVE_SNAPSHOT: 'live-snapshot',
} as const;

export type LiveDataJobName = (typeof LIVE_JOBS)[keyof typeof LIVE_JOBS];

export interface LiveDataJobData {
  seasonId: number;
  seasonCode: string;
  eventId: number;
  source: 'cron' | 'manual' | 'cascade';
  triggeredAt: string;
  /** Large event-live/explain UPSERTs run every ten minutes and at consolidation. */
  persistEventLives?: boolean;
  /** Only the post-match consolidation may publish terminal live authority. */
  finalizeEvent?: boolean;
}

export const liveDataQueue = new Queue<LiveDataJobData>(liveDataQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60_000, // 1 minute
    },
    removeOnComplete: {
      age: 86400, // 24 hours
      count: 100,
    },
    removeOnFail: {
      age: 172800, // 48 hours
      count: 50,
    },
  },
});

export async function closeLiveDataQueue() {
  await liveDataQueue.close();
}
