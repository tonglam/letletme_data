import { randomUUID } from 'node:crypto';

import type { FplSeasonRef } from '../domain/fpl-season';
import {
  fplPriceWatchQueue,
  fplPriceWatchQueueName,
  type FplPriceWatchJobData,
} from '../queues/fpl-price-watch.queue';
import { logInfo } from '../utils/logger';

export async function enqueueFplPriceWatchJob(
  season: FplSeasonRef,
  input: {
    readonly deadlineAt: Date;
    readonly obligationId?: string;
    readonly obligationGeneration?: number;
    readonly jobId: string;
    readonly source?: 'catchup' | 'reconcile' | 'manual';
  },
) {
  if (!Number.isFinite(input.deadlineAt.getTime())) {
    throw new Error('Price-watch deadline is invalid');
  }
  const data: FplPriceWatchJobData = {
    seasonId: season.seasonId,
    seasonCode: season.seasonCode,
    source: input.source ?? 'catchup',
    triggeredAt: new Date().toISOString(),
    runId: randomUUID(),
    watchId: `${season.seasonCode}:${input.deadlineAt.toISOString()}`,
    deadlineAt: input.deadlineAt.toISOString(),
    ...(input.obligationId ? { obligationId: input.obligationId } : {}),
    ...(input.obligationGeneration === undefined
      ? {}
      : { obligationGeneration: input.obligationGeneration }),
  };
  const job = await fplPriceWatchQueue.add('price-change-watch', data, {
    jobId: `${season.seasonCode}-${input.jobId}`,
  });
  logInfo('FPL price-watch job enqueued', {
    queue: fplPriceWatchQueueName,
    jobId: job.id,
    season: season.seasonCode,
    deadlineAt: data.deadlineAt,
    watchId: data.watchId,
  });
  return job;
}
