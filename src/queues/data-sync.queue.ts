import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { dataSyncQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

export { dataSyncQueueName } from './names';

export type DataSyncJobName =
  | 'core-snapshot'
  | 'player-prices'
  | 'player-stats'
  | 'player-values'
  | 'price-change-predictions';

export interface DataSyncJobData {
  seasonId: number;
  seasonCode: string;
  source?: 'cron' | 'manual' | 'api' | 'event-transition' | 'cascade' | 'catchup' | 'reconcile';
  triggeredAt: string;
  /** Correlates one logical execution across BullMQ retries; independent of queue dedupe ID. */
  runId?: string;
  /** Durable scheduler obligation identity carried through worker completion. */
  obligationId?: string;
  obligationGeneration?: number;
  /** Single-flight scheduler lane identity, when the job is lane-managed. */
  laneId?: string;
  laneGeneration?: number;
  blockerLaneId?: string;
  /** Exact provisional source identity handed to durable price reconciliation. */
  sourceHash?: string;
  sourceArtifactId?: string;
  priceChangeBoardRevision?: string;
  /** Optional event filter (fixtures, player-stats); absent = current/all behavior */
  eventId?: number;
  /** Price-history date in the configured cron timezone (YYYYMMDD). */
  changeDate?: string;
  /** Exact freshness window being repaired, when this is a governance retry. */
  freshnessWindowId?: number;
  /** All joined freshness windows for a shared latest-wins publication. */
  freshnessWindowIds?: readonly number[];
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 60_000,
  },
  // Keep deterministic execution evidence long enough for production
  // incident review. Queue emptiness is not success evidence.
  removeOnComplete: BULL_COMPLETED_RETENTION,
  removeOnFail: BULL_FAILED_RETENTION,
};

export const dataSyncQueue = new Queue<DataSyncJobData>(dataSyncQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions,
});

export async function closeDataSyncQueue() {
  await dataSyncQueue.close();
}
