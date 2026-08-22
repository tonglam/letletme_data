import { Queue } from 'bullmq';

import type { UnderstatSyncMode, UnderstatSyncTrigger } from '../domain/understat';
import { getQueueConnection } from '../utils/queue';
import { understatTeamQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

export { understatTeamQueueName } from './names';

export type UnderstatTeamJobName =
  | 'understat-team-discover'
  | 'understat-team-detail'
  | 'understat-team-finalize';

export interface UnderstatTeamJobData {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  teamId?: number;
  teamTitle?: string;
  teamIds?: number[];
}

let understatTeamQueue: Queue<UnderstatTeamJobData> | null = null;

export function getUnderstatTeamQueue(): Queue<UnderstatTeamJobData> {
  understatTeamQueue ??= new Queue<UnderstatTeamJobData>(understatTeamQueueName, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'understat', delay: 1_000 },
      removeOnComplete: BULL_COMPLETED_RETENTION,
      removeOnFail: BULL_FAILED_RETENTION,
    },
  });
  return understatTeamQueue;
}

export async function closeUnderstatTeamQueue(): Promise<void> {
  const queue = understatTeamQueue;
  understatTeamQueue = null;
  await queue?.close();
}
