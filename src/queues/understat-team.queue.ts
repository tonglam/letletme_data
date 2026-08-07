import { Queue } from 'bullmq';

import type { UnderstatSyncMode, UnderstatSyncTrigger } from '../domain/understat';
import { getQueueConnection } from '../utils/queue';

export const understatTeamQueueName = 'understat-team-sync';

export type UnderstatTeamJobName =
  | 'understat-team-discover'
  | 'understat-team-detail'
  | 'understat-team-publish';

export interface UnderstatTeamJobData {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  teamId?: number;
  teamTitle?: string;
  teamIds?: number[];
}

export const understatTeamQueue = new Queue<UnderstatTeamJobData>(understatTeamQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'understat', delay: 1_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export async function closeUnderstatTeamQueue(): Promise<void> {
  await understatTeamQueue.close();
}
