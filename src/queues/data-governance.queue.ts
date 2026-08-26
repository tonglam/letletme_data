import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { dataGovernanceQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

export { dataGovernanceQueueName } from './names';

export const DATA_GOVERNANCE_JOBS = {
  LIFECYCLE_STATUS: 'lifecycle-status',
  PUBLICATION_RECONCILE: 'publication-reconcile',
  FRESHNESS_OBSERVER: 'freshness-observer',
  GW_AUDIT: 'gw-audit',
  CASE_RECHECK: 'governance-case-recheck',
} as const;
export type DataGovernanceJobName =
  (typeof DATA_GOVERNANCE_JOBS)[keyof typeof DATA_GOVERNANCE_JOBS];

export type DataGovernanceJobData = Readonly<{
  jobName: DataGovernanceJobName;
  seasonId: number;
  seasonCode: string;
  triggeredAt: string;
  eventId?: number;
  scopeKey?: string;
  obligationId?: string;
  obligationGeneration?: number;
}>;

export const dataGovernanceQueue = new Queue<DataGovernanceJobData>(dataGovernanceQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
  },
});

export async function closeDataGovernanceQueue(): Promise<void> {
  await dataGovernanceQueue.close();
}
