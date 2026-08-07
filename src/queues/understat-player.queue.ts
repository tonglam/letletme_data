import { Queue } from 'bullmq';

import type { UnderstatSyncMode, UnderstatSyncTrigger } from '../domain/understat';
import { getQueueConnection } from '../utils/queue';

export const understatPlayerQueueName = 'understat-player-sync';

export type UnderstatPlayerJobName =
  | 'understat-player-discover'
  | 'understat-player-team-detail'
  | 'understat-player-match'
  | 'understat-player-publish';

export interface UnderstatPlayerJobData {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  resourceId?: number;
  teamTitle?: string;
  teamIds?: number[];
  matchIds?: number[];
  participantsOnly?: boolean;
}

export const understatPlayerQueue = new Queue<UnderstatPlayerJobData>(understatPlayerQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export async function closeUnderstatPlayerQueue(): Promise<void> {
  await understatPlayerQueue.close();
}
