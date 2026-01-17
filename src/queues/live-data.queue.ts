import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';

export const liveDataQueueName = 'live-data';

export const LIVE_JOBS = {
  EVENT_LIVES_CACHE: 'event-lives-cache',
  EVENT_LIVES_DB: 'event-lives-db',
  EVENT_LIVE_SUMMARY: 'event-live-summary',
  EVENT_LIVE_EXPLAIN: 'event-live-explain',
  EVENT_OVERALL_RESULT: 'event-overall-result',
} as const;

export type LiveDataJobName = (typeof LIVE_JOBS)[keyof typeof LIVE_JOBS];

export interface LiveDataJobData {
  eventId: number;
  source: 'cron' | 'manual' | 'cascade';
  triggeredAt: string;
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
