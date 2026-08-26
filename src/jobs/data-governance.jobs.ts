import { randomUUID } from 'node:crypto';

import type { FplSeasonRef } from '../domain/fpl-season';
import {
  DATA_GOVERNANCE_JOBS,
  dataGovernanceQueue,
  type DataGovernanceJobName,
} from '../queues/data-governance.queue';
import { logInfo } from '../utils/logger';

export async function enqueueDataGovernanceJob(
  season: FplSeasonRef,
  jobName: DataGovernanceJobName,
  options: Readonly<{
    eventId?: number;
    scopeKey?: string;
    obligationId?: string;
    obligationGeneration?: number;
    jobId?: string;
  }> = {},
) {
  const job = await dataGovernanceQueue.add(
    jobName,
    {
      jobName,
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      triggeredAt: new Date().toISOString(),
      ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
      ...(options.scopeKey ? { scopeKey: options.scopeKey } : {}),
      ...(options.obligationId ? { obligationId: options.obligationId } : {}),
      ...(options.obligationGeneration === undefined
        ? {}
        : { obligationGeneration: options.obligationGeneration }),
    },
    {
      jobId: options.jobId ?? `${jobName}-${season.seasonCode}-${Date.now()}-${randomUUID()}`,
    },
  );
  logInfo('Data governance job enqueued', {
    jobName,
    jobId: job.id,
    queue: dataGovernanceQueue.name,
  });
  return job;
}

export { DATA_GOVERNANCE_JOBS };
