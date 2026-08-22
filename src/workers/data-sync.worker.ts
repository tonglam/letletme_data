import { QueueEvents, Worker, type Job } from 'bullmq';

import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import { enqueuePlayerPricesSyncJob } from '../jobs/data-sync-enqueue';
import { type DataSyncJobData, dataSyncQueue, dataSyncQueueName } from '../queues/data-sync.queue';
import { syncPlayerPricesForDate } from '../services/player-prices.service';
import { syncCurrentPlayerStats, syncPlayerStatsForEvent } from '../services/player-stats.service';
import {
  persistPreparedPlayerValuesSync,
  preparePlayerValuesSync,
} from '../services/player-values.service';
import { ensureMarketPublication } from '../services/market-publication.service';
import { readActiveDataPublication } from '../cache/data-publication';
import { dispatchDataPublicationOutbox } from '../repositories/data-publication-outbox';
import { syncCoreSnapshot } from '../services/core-snapshot.service';
import {
  resolveBullMqAttemptQueueWaitMs,
  runDataSyncAttempt,
  type DataSyncAttemptContext,
} from '../utils/data-sync-attempt';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure, notifyTwoBots } from '../utils/notify';
import { isTerminalJobFailure } from '../utils/worker-failure';
import { withMutationScopes } from '../utils/mutation-scopes';
import { formatCronDateKey } from '../utils/timezone';
import type { WorkerRuntime } from './worker-runtime';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
} from '../repositories/scheduler-obligations';

const processDataSyncJob = async (job: Job<DataSyncJobData>) => {
  const season = await requireCurrentSeasonForJob(job.data);
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    source: job.data?.source as string | undefined,
    attempt: job.attemptsMade + 1,
    queueWaitMs: resolveBullMqAttemptQueueWaitMs(job),
  };
  const attemptContext: DataSyncAttemptContext = {
    queue: job.queueName,
    jobName: job.name,
    runId: job.data?.runId ?? String(job.id ?? `${job.name}-${job.timestamp}`),
    source: job.data?.source,
    attempt: job.attemptsMade + 1,
    targetEventId: job.data?.eventId,
    queueWaitMs: context.queueWaitMs,
  };
  const recordResolvedTarget = (eventId: number) => {
    attemptContext.targetEventId = eventId;
  };

  logJobTriggered(context);

  return runDataSyncAttempt(attemptContext, async () => {
    const mutationInput = {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
    };

    // The player-values snapshot is the parent write for the price-sync job.
    // Commit it under the database scope before exposing the dependent job to
    // another worker; otherwise the child can read the previous snapshot.
    if (job.name === 'player-values') {
      return runTrackedJob(context, async () => {
        const changeDate = job.data.changeDate ?? formatCronDateKey(new Date(job.data.triggeredAt));
        // Fetch and validate the immutable upstream payload before taking the
        // canonical mutation lock.  Snapshot/view rows and the DB publication
        // proof/outbox are committed together; Redis delivery, notification,
        // and child enqueue happen only after that transaction commits.
        const prepared = await preparePlayerValuesSync(season, changeDate, undefined, {
          onTargetEventResolved: recordResolvedTarget,
        });
        if (!prepared) return { count: 0, outcome: 'noop' as const };
        let marketPublication: Awaited<ReturnType<typeof ensureMarketPublication>> | undefined;
        const result = await withMutationScopes(mutationInput, async () => {
          const persisted = await persistPreparedPlayerValuesSync(prepared, undefined, {
            deferPriceSyncEnqueue: true,
            deferMarketPublication: true,
            deferNotification: true,
          });
          marketPublication = await ensureMarketPublication(season, { deferDelivery: true });
          return persisted;
        });
        if (marketPublication?.publicationId) {
          const delivered = await dispatchDataPublicationOutbox({
            limit: 1,
            publicationId: marketPublication.publicationId,
          });
          if (delivered.delivered !== 1) {
            const active = await readActiveDataPublication({
              dataset: 'fpl:market',
              seasonCode: season.seasonCode,
            });
            if (
              active?.manifest.publicationId !== marketPublication.publicationId ||
              active.manifest.revision !== marketPublication.revision
            ) {
              throw new Error(
                `Market publication ${marketPublication.publicationId} is canonical but Redis delivery is pending`,
              );
            }
          }
        }
        if (result.notificationMessage) {
          await notifyTwoBots(result.notificationMessage, {
            // Notifications are downstream of the canonical publication. Use
            // its immutable identity so retries after a process crash remain
            // idempotent even when they cross a UTC minute boundary.
            idempotencyKey: `market:${season.seasonCode}:${changeDate}:${marketPublication?.publicationId ?? 'snapshot'}`,
          });
        }
        if (result.count > 0) {
          await enqueuePlayerPricesSyncJob(season, 'cascade', {
            changeDate,
            jobId: `player-prices-${changeDate}-immediate`,
            removeOnSettle: false,
          });
        }
        return result;
      });
    }

    const execute = () =>
      runTrackedJob(context, async () => {
        switch (job.name) {
          case 'core-snapshot':
            return syncCoreSnapshot(season);
          case 'player-prices':
            if (!job.data.changeDate) {
              throw new Error('player-prices job requires changeDate');
            }
            return syncPlayerPricesForDate(season, job.data.changeDate);
          case 'player-stats':
            return job.data.eventId !== undefined
              ? syncPlayerStatsForEvent(season, job.data.eventId)
              : syncCurrentPlayerStats(season, { onTargetEventResolved: recordResolvedTarget });
          default:
            throw new Error(`Unknown data-sync job: ${job.name}`);
        }
      });

    // Core aliases perform upstream reads before acquiring their own short
    // multi-table persistence/publication lock.
    if (job.name === 'core-snapshot') return execute();
    return withMutationScopes(mutationInput, execute);
  });
};

export function createDataSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<DataSyncJobData>(dataSyncQueueName, processDataSyncJob, {
    connection,
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(dataSyncQueueName, { connection });

  worker.on('completed', (job) => {
    logInfo('Data sync job completed', { jobId: job.id, name: job.name });
    if (job.id !== undefined) {
      const completion = job.data.obligationId
        ? completeSchedulerObligation({
            obligationId: job.data.obligationId,
            generation: job.data.obligationGeneration,
            status: 'succeeded',
            evidence: { queue: dataSyncQueueName, jobName: job.name },
          })
        : completeSchedulerObligationByBullJobId({
            bullJobId: job.id,
            evidence: { queue: dataSyncQueueName, jobName: job.name },
          });
      void completion.catch(() => undefined);
    }
  });

  worker.on('failed', (job, error) => {
    logError('Data sync job failed', error, {
      jobId: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
    });
    if (job) {
      void alertOnFinalFailure(job, error);
      if (isTerminalJobFailure(job, error) && job.data.obligationId) {
        void failSchedulerObligation({
          obligationId: job.data.obligationId,
          generation: job.data.obligationGeneration,
          error,
        }).catch(() => undefined);
      } else if (job.id !== undefined && isTerminalJobFailure(job, error)) {
        void failSchedulerObligationByBullJobId({ bullJobId: job.id, error }).catch(
          () => undefined,
        );
      }
    }
  });

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: dataSyncQueue, queueEvents, queueName: dataSyncQueueName }],
  };
}
