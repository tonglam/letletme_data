import { Queue } from 'bullmq';

import type { UnderstatSyncMode, UnderstatSyncTrigger } from '../domain/understat';
import { getQueueConnection } from '../utils/queue';
import { understatPlayerQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

export { understatPlayerQueueName } from './names';

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
  obligationId?: string;
  obligationGeneration?: number;
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
      removeOnComplete: BULL_COMPLETED_RETENTION,
      removeOnFail: BULL_FAILED_RETENTION,
    },
  });
  return understatPlayerQueue;
}

export async function closeUnderstatPlayerQueue(): Promise<void> {
  const queue = understatPlayerQueue;
  understatPlayerQueue = null;
  await queue?.close();
}
