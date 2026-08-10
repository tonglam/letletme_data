import { Queue } from 'bullmq';

import type { UnderstatSyncMode, UnderstatSyncTrigger } from '../domain/understat';
import { getQueueConnection } from '../utils/queue';

export const understatPlayerQueueName = 'understat-player-sync';

export type UnderstatPlayerJobName =
  | 'understat-player-discover'
  | 'understat-player-team-detail'
  | 'understat-player-match'
  | 'understat-player-finalize';

export interface UnderstatPlayerJobData {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  resourceId?: number;
  teamTitle?: string;
  teamIds?: number[];
  matchIds?: number[];
}

let understatPlayerQueue: Queue<UnderstatPlayerJobData> | null = null;

export function getUnderstatPlayerQueue(): Queue<UnderstatPlayerJobData> {
  understatPlayerQueue ??= new Queue<UnderstatPlayerJobData>(understatPlayerQueueName, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'understat', delay: 1_000 },
      removeOnComplete: { count: 20, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 50, age: 14 * 24 * 60 * 60 },
    },
  });
  return understatPlayerQueue;
}

export async function closeUnderstatPlayerQueue(): Promise<void> {
  const queue = understatPlayerQueue;
  understatPlayerQueue = null;
  await queue?.close();
}
