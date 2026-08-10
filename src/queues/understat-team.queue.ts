import { Queue } from 'bullmq';

import type { UnderstatSyncMode, UnderstatSyncTrigger } from '../domain/understat';
import { getQueueConnection } from '../utils/queue';

export const understatTeamQueueName = 'understat-team-sync';

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
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
  return understatTeamQueue;
}

export async function closeUnderstatTeamQueue(): Promise<void> {
  const queue = understatTeamQueue;
  understatTeamQueue = null;
  await queue?.close();
}
