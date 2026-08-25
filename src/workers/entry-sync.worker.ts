import { QueueEvents, Worker, type Job } from 'bullmq';
import { and, asc, eq, gt } from 'drizzle-orm';

import {
  isExplicitEntryRepairRequest,
  isCronEntryInfoTableScan,
  shouldRefreshEntryPicks,
  resolveEntrySyncTargetEventId,
  resolveRichResultFreshnessCutoff,
} from '../domain/entry-sync';
import { decideEntrySyncChain, planEntryInfoSyncWork } from '../domain/entry-sync-chain';
import { entriesInCompetition } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import {
  type EntrySyncJobData,
  type EntrySyncJobSource,
  type EntrySyncJobName,
  ENTRY_SYNC_DEFAULT_CHUNK_SIZE,
  ENTRY_SYNC_DEFAULT_CONCURRENCY,
  ENTRY_SYNC_DEFAULT_THROTTLE_MS,
  entrySyncQueue,
  entrySyncQueueName,
} from '../queues/entry-sync.queue';
import {
  enqueueEntryInfoSyncJob,
  enqueueEntryPicksSyncJob,
  enqueueEntryResultsSyncJob,
  enqueueEntryTransfersSyncJob,
  retainEntrySyncChainOptions,
  type EntrySyncJobOptions,
} from '../jobs/entry-sync-enqueue';
import { syncEntryInfo } from '../services/entry-info.service';
import { getCurrentEvent } from '../services/events.service';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { entryEventTransfersRepository } from '../repositories/entry-event-transfers';
import { entryInfoRepository } from '../repositories/entry-infos';
import { eventRepository } from '../repositories/events';
import {
  syncEntryEventPicks,
  syncEntryEventResults,
  syncEntryEventTransfers,
} from '../services/entries.service';
import {
  markEntryInfoSyncedToday,
  shouldMarkEntryInfoSynced,
} from '../jobs/entry-info-sync-marker';
import {
  resolveBullMqAttemptQueueWaitMs,
  resolveDataSyncAttempt,
  runDataSyncAttempt,
  type DataSyncAttemptContext,
} from '../utils/data-sync-attempt';
import { tournamentEntryCoreScopes } from '../domain/mutation-scope';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { isTerminalJobFailure } from '../utils/worker-failure';
import { IncompleteDataSyncError } from '../utils/errors';
import { withMutationScopes } from '../utils/mutation-scopes';
import { getQueueConnection } from '../utils/queue';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
  renewSchedulerObligation,
} from '../repositories/scheduler-obligations';
import type { WorkerRuntime } from './worker-runtime';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';

const maxRetryCycles = 2;
const retryBaseDelayMs = 5 * 60_000;
const retryMaxDelayMs = 30 * 60_000;

interface LoadedEntryIds {
  entryIds: number[];
  hasMore: boolean;
  lastEntryId: number | null;
  chunkSize: number;
  afterEntryId: number;
  fetchedFromDb: boolean;
}

interface SyncEntriesOptions {
  concurrency: number;
  throttleMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveRetryDelayMs(retryCount: number): number {
  const delayMultiplier = Math.max(retryCount, 1);
  return Math.min(retryBaseDelayMs * delayMultiplier, retryMaxDelayMs);
}

async function renewEntrySyncObligationLease(
  jobData: Pick<EntrySyncJobData, 'obligationId' | 'obligationGeneration'> | undefined,
  additionalLeaseMs = 0,
): Promise<boolean> {
  if (!jobData) return true;
  const fence = inspectSchedulerObligationFence(jobData);
  if (fence.kind === 'none') return true;
  if (fence.kind === 'malformed') return false;
  return renewSchedulerObligation({
    obligationId: fence.obligationId,
    generation: fence.generation,
    additionalLeaseMs,
  });
}

export async function loadEntryIdsForSync(
  season: FplSeasonRef,
  jobData?: EntrySyncJobData,
): Promise<LoadedEntryIds> {
  const chunkSize = jobData?.chunkSize ?? ENTRY_SYNC_DEFAULT_CHUNK_SIZE;
  const afterEntryId = jobData?.afterEntryId ?? 0;

  if (jobData?.entryIds && jobData.entryIds.length > 0) {
    const entryIds = Array.from(new Set(jobData.entryIds));
    return {
      entryIds,
      hasMore: false,
      lastEntryId: null,
      chunkSize,
      afterEntryId,
      fetchedFromDb: false,
    };
  }

  const db = await getDb();
  const rows = await db
    .select({ id: entriesInCompetition.entryId })
    .from(entriesInCompetition)
    .where(
      and(
        eq(entriesInCompetition.seasonId, season.seasonId),
        gt(entriesInCompetition.entryId, afterEntryId),
      ),
    )
    .orderBy(asc(entriesInCompetition.entryId))
    .limit(chunkSize);

  const ids = rows.map((row) => row.id);
  return {
    entryIds: ids,
    hasMore: ids.length === chunkSize,
    lastEntryId: ids.at(-1) ?? null,
    chunkSize,
    afterEntryId,
    fetchedFromDb: true,
  };
}

async function syncEntries(
  label: string,
  entryIds: number[],
  handler: (entryId: number) => Promise<unknown>,
  options: SyncEntriesOptions,
): Promise<{ total: number; success: number; failed: number; failedIds: number[] }> {
  if (entryIds.length === 0) {
    return { total: 0, success: 0, failed: 0, failedIds: [] };
  }

  logInfo(`Found entries for ${label}`, {
    count: entryIds.length,
    concurrency: options.concurrency,
  });

  let success = 0;
  let failed = 0;
  const failedIds: number[] = [];
  let index = 0;
  const workerCount = Math.max(1, Math.min(options.concurrency, entryIds.length));

  const runWorker = async () => {
    while (index < entryIds.length) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= entryIds.length) {
        break;
      }
      const entryId = entryIds[currentIndex];
      try {
        await handler(entryId);
        success += 1;
      } catch (error) {
        failed += 1;
        failedIds.push(entryId);
        logError(`${label} failed for entry`, error, { entryId });
      }

      if (options.throttleMs > 0) {
        await sleep(options.throttleMs);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));

  return { total: entryIds.length, success, failed, failedIds };
}

async function enqueueEntryJob(
  season: FplSeasonRef,
  jobName: EntrySyncJobName,
  source: EntrySyncJobSource | undefined,
  options: EntrySyncJobOptions,
) {
  switch (jobName) {
    case 'entry-info':
      return enqueueEntryInfoSyncJob(season, source, options);
    case 'entry-picks':
      return enqueueEntryPicksSyncJob(season, source, options);
    case 'entry-transfers':
      return enqueueEntryTransfersSyncJob(season, source, options);
    case 'entry-results':
      return enqueueEntryResultsSyncJob(season, source, options);
  }
}

async function scheduleRetry(
  season: FplSeasonRef,
  jobName: EntrySyncJobName,
  jobData: Partial<EntrySyncJobData> | undefined,
  failedIds: number[],
  retryCount: number,
) {
  const delayMs = resolveRetryDelayMs(retryCount);

  return enqueueEntryJob(season, jobName, jobData?.source, {
    entryIds: failedIds,
    retryCount,
    concurrency: jobData?.concurrency,
    throttleMs: jobData?.throttleMs,
    delayMs,
    eventId: jobData?.eventId,
    ...retainEntrySyncChainOptions(jobData),
    resumeAfterEntryId: jobData?.resumeAfterEntryId,
  });
}

type RequiredEntrySelector = (
  entryIds: number[],
) => Promise<{ requiredEntryIds: number[]; reusedUnits: number }>;

interface HandleEntryJobOptions {
  selectRequired?: RequiredEntrySelector;
  auditRequired?: (entryIds: number[]) => Promise<number[]>;
}

type PostCommitIntent = () => Promise<void>;

interface EntrySyncSummary {
  total: number;
  success: number;
  failed: number;
  failedIds: number[];
  hasMore: boolean;
  fetchedFromDb: boolean;
  scanComplete: boolean;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}

interface EntrySyncMutationResult {
  value: EntrySyncSummary;
  afterCommit?: PostCommitIntent;
}

async function handleEntryJob(
  season: FplSeasonRef,
  jobName: EntrySyncJobName,
  label: string,
  handler: (entryId: number) => Promise<unknown>,
  jobData?: EntrySyncJobData,
  options: HandleEntryJobOptions = {},
): Promise<EntrySyncMutationResult> {
  const loaded = await loadEntryIdsForSync(season, jobData);
  if (loaded.entryIds.length === 0) {
    logInfo(`No entries found for ${label}`, {
      jobName,
      afterEntryId: loaded.afterEntryId,
    });
    return {
      value: {
        total: 0,
        success: 0,
        failed: 0,
        failedIds: [],
        hasMore: false,
        fetchedFromDb: loaded.fetchedFromDb,
        scanComplete: loaded.fetchedFromDb,
        requiredUnits: 0,
        reusedUnits: 0,
        succeededUnits: 0,
        failedUnits: 0,
      },
    };
  }

  const concurrency = jobData?.concurrency ?? ENTRY_SYNC_DEFAULT_CONCURRENCY;
  const throttleMs = jobData?.throttleMs ?? ENTRY_SYNC_DEFAULT_THROTTLE_MS;

  const selection = options.selectRequired
    ? await options.selectRequired(loaded.entryIds)
    : { requiredEntryIds: loaded.entryIds, reusedUnits: 0 };
  let result = await syncEntries(label, selection.requiredEntryIds, handler, {
    concurrency,
    throttleMs,
  });

  if (options.auditRequired && selection.requiredEntryIds.length > 0) {
    const missingIds = await options.auditRequired(selection.requiredEntryIds);
    if (missingIds.length > 0) {
      const failedIds = [...new Set([...result.failedIds, ...missingIds])];
      result = {
        ...result,
        success: Math.max(0, result.total - failedIds.length),
        failed: failedIds.length,
        failedIds,
      };
    }
  }

  const decision = decideEntrySyncChain({
    failedUnits: result.failed,
    retryCount: jobData?.retryCount ?? 0,
    maxRetryCycles,
    fetchedFromDb: loaded.fetchedFromDb,
    hasMore: loaded.hasMore,
    lastEntryId: loaded.lastEntryId,
    resumeAfterEntryId: jobData?.resumeAfterEntryId,
  });

  if (decision.action === 'retry_failed') {
    return {
      value: {
        ...result,
        total: loaded.entryIds.length,
        hasMore: true,
        fetchedFromDb: loaded.fetchedFromDb,
        scanComplete: false,
        requiredUnits: selection.requiredEntryIds.length,
        reusedUnits: selection.reusedUnits,
        succeededUnits: result.success,
        failedUnits: result.failed,
      },
      afterCommit: async () => {
        // Keep the obligation alive through the delayed retry.  A fixed lease
        // measured from the first generation would expire while the next
        // retry is still waiting in BullMQ, allowing the scheduler to enqueue
        // an overlapping generation against the same mutation scopes.
        const leaseRenewed = await renewEntrySyncObligationLease(
          jobData,
          resolveRetryDelayMs(decision.retryCount),
        );
        if (!leaseRenewed) {
          logInfo('Entry sync retry skipped for stale scheduler generation', {
            jobName,
            obligationId: jobData?.obligationId,
            obligationGeneration: jobData?.obligationGeneration,
          });
          return;
        }
        const retryJob = await scheduleRetry(
          season,
          jobName,
          { ...jobData, resumeAfterEntryId: decision.resumeAfterEntryId },
          result.failedIds,
          decision.retryCount,
        );
        logInfo('Entry sync retry enqueued', {
          jobName,
          retryCount: decision.retryCount,
          failed: result.failedIds.length,
          jobId: retryJob?.id,
        });
      },
    };
  }

  if (decision.action === 'fail') {
    const error = new IncompleteDataSyncError(
      `Entry ${jobName} synchronization exhausted its bounded retries`,
      selection.requiredEntryIds.length,
      selection.reusedUnits,
      result.success,
      result.failed,
    );
    logError('Entry sync retry limit reached', error, {
      jobName,
      retryCount: (jobData?.retryCount ?? 0) + 1,
      failed: result.failedIds.length,
    });
    throw error;
  }

  if (decision.action === 'continue_scan') {
    const value: EntrySyncSummary = {
      ...result,
      total: loaded.entryIds.length,
      hasMore: true,
      fetchedFromDb: loaded.fetchedFromDb,
      scanComplete: false,
      requiredUnits: selection.requiredEntryIds.length,
      reusedUnits: selection.reusedUnits,
      succeededUnits: result.success,
      failedUnits: result.failed,
    };
    return {
      value,
      afterCommit: async () => {
        const leaseRenewed = await renewEntrySyncObligationLease(jobData);
        if (!leaseRenewed) {
          logInfo('Entry sync continuation skipped for stale scheduler generation', {
            jobName,
            obligationId: jobData?.obligationId,
            obligationGeneration: jobData?.obligationGeneration,
          });
          return;
        }
        const nextJob = await enqueueEntryJob(season, jobName, jobData?.source, {
          afterEntryId: decision.afterEntryId,
          chunkSize: loaded.chunkSize,
          concurrency,
          throttleMs,
          eventId: jobData?.eventId,
          ...retainEntrySyncChainOptions(jobData),
        });
        logInfo('Entry sync next keyset chunk enqueued', {
          jobName,
          afterEntryId: decision.afterEntryId,
          jobId: nextJob?.id,
        });
      },
    };
  }

  const scanComplete = loaded.fetchedFromDb && decision.action === 'complete';
  return {
    value: {
      ...result,
      total: loaded.entryIds.length,
      hasMore: false,
      fetchedFromDb: loaded.fetchedFromDb,
      scanComplete,
      requiredUnits: selection.requiredEntryIds.length,
      reusedUnits: selection.reusedUnits,
      succeededUnits: result.success,
      failedUnits: result.failed,
    },
  };
}

export function createEntrySyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();

  const processor = async (job: Job<EntrySyncJobData>) => {
    const jobId = job.id ?? `${job.name}-${job.timestamp}`;
    if (
      !(await startCurrentSchedulerJob(job.data, {
        queueName: job.queueName,
        jobName: job.name,
        jobId,
      }))
    ) {
      return { skipped: true, staleSchedulerGeneration: true };
    }
    const season = await requireCurrentSeasonForJob(job.data);
    const attempt = resolveDataSyncAttempt(
      job.data?.source,
      job.attemptsMade,
      job.data?.retryCount,
    );
    const context = {
      jobType: 'queue' as const,
      queueName: job.queueName,
      jobId,
      jobName: job.name,
      source: attempt.source as string | undefined,
      eventId: job.data?.eventId,
      attempt: attempt.attempt,
      queueWaitMs: resolveBullMqAttemptQueueWaitMs(job),
    };

    logJobTriggered(context);

    const attemptContext: DataSyncAttemptContext = {
      queue: job.queueName,
      jobName: job.name,
      runId: job.data?.runId ?? String(jobId),
      source: attempt.source,
      attempt: attempt.attempt,
      targetEventId: job.data?.eventId,
      queueWaitMs: context.queueWaitMs,
    };

    return runDataSyncAttempt(attemptContext, async () => {
      const targetEventId = await resolveEntrySyncTargetEventId(
        job.name as EntrySyncJobName,
        job.data?.eventId,
        async () => (await getCurrentEvent(season))?.id ?? null,
      );
      const effectiveJobData =
        targetEventId !== undefined ? { ...job.data, eventId: targetEventId } : job.data;
      context.eventId = targetEventId;
      attemptContext.targetEventId = targetEventId;
      const entryInfoScopes =
        job.name === 'entry-info'
          ? tournamentEntryCoreScopes(
              season.seasonId,
              (await loadEntryIdsForSync(season, effectiveJobData)).entryIds,
            )
          : undefined;
      const runMutation = async (): Promise<EntrySyncMutationResult> => {
        switch (job.name) {
          case 'entry-info': {
            const result = await handleEntryJob(
              season,
              'entry-info',
              'entry info sync',
              (entryId) => syncEntryInfo(season, entryId, undefined, targetEventId),
              effectiveJobData,
              {
                selectRequired: async (entryIds) => {
                  if (targetEventId === undefined) {
                    return { requiredEntryIds: entryIds, reusedUnits: 0 };
                  }
                  const requiredEntryIds = await entryInfoRepository.findIdsNeedingSnapshotSync(
                    season,
                    entryIds,
                    targetEventId,
                  );
                  return planEntryInfoSyncWork(
                    entryIds,
                    requiredEntryIds,
                    isCronEntryInfoTableScan(effectiveJobData),
                  );
                },
              },
            );
            // Only a complete scheduled database scan can satisfy the
            // daily marker; targeted API and retry jobs remain eligible.
            const shouldMark =
              effectiveJobData?.source === 'cron' &&
              shouldMarkEntryInfoSynced(
                result.value.fetchedFromDb,
                result.value.hasMore,
                result.value.failed,
              );
            return {
              value: result.value,
              afterCommit: async () => {
                await result.afterCommit?.();
                if (shouldMark) await markEntryInfoSyncedToday(new Date(), job.id);
              },
            };
          }
          case 'entry-picks':
            return handleEntryJob(
              season,
              'entry-picks',
              'entry picks sync',
              (entryId) => syncEntryEventPicks(season, entryId, targetEventId!),
              effectiveJobData,
              {
                selectRequired: async (entryIds) => {
                  if (targetEventId === undefined) {
                    return { requiredEntryIds: entryIds, reusedUnits: 0 };
                  }
                  // Explicit API/manual entry lists are repair requests,
                  // so they must refetch even when a warm row exists. Only
                  // scheduled scans may reuse a complete picks row.
                  if (shouldRefreshEntryPicks(effectiveJobData)) {
                    return { requiredEntryIds: entryIds, reusedUnits: 0 };
                  }
                  const existing = new Set(
                    await entryEventPicksRepository.findEntryIdsByEvent(
                      season,
                      targetEventId,
                      entryIds,
                    ),
                  );
                  return {
                    requiredEntryIds: entryIds.filter((entryId) => !existing.has(entryId)),
                    reusedUnits: existing.size,
                  };
                },
                auditRequired: (entryIds) =>
                  entryEventPicksRepository
                    .findEntryIdsByEvent(season, targetEventId!, entryIds)
                    .then((persisted) => {
                      const persistedSet = new Set(persisted);
                      return entryIds.filter((entryId) => !persistedSet.has(entryId));
                    }),
              },
            );
          case 'entry-transfers':
            return handleEntryJob(
              season,
              'entry-transfers',
              'entry transfers sync',
              (entryId) => syncEntryEventTransfers(season, entryId, targetEventId!),
              effectiveJobData,
              {
                selectRequired: async (entryIds) => {
                  if (targetEventId === undefined) {
                    return { requiredEntryIds: entryIds, reusedUnits: 0 };
                  }
                  if (isExplicitEntryRepairRequest(effectiveJobData)) {
                    return { requiredEntryIds: entryIds, reusedUnits: 0 };
                  }
                  const requiredEntryIds =
                    await entryEventTransfersRepository.findEntryIdsNeedingSync(
                      season,
                      entryIds,
                      targetEventId,
                    );
                  return {
                    requiredEntryIds,
                    reusedUnits: entryIds.length - requiredEntryIds.length,
                  };
                },
                auditRequired: (entryIds) =>
                  entryEventTransfersRepository.findEntryIdsNeedingSync(
                    season,
                    entryIds,
                    targetEventId!,
                  ),
              },
            );
          case 'entry-results':
            return handleEntryJob(
              season,
              'entry-results',
              'entry results sync',
              (entryId) => syncEntryEventResults(season, entryId, targetEventId!),
              effectiveJobData,
              {
                selectRequired: async (entryIds) => {
                  if (targetEventId === undefined) {
                    return { requiredEntryIds: entryIds, reusedUnits: 0 };
                  }
                  // Explicit API/manual entry lists are repair requests.
                  // A finalized checkpoint must not suppress their source
                  // refresh, matching the adjacent picks repair behavior.
                  if (isExplicitEntryRepairRequest(effectiveJobData)) {
                    return { requiredEntryIds: entryIds, reusedUnits: 0 };
                  }
                  // Active-GW values can still change. Reuse the dedicated
                  // rich-result checkpoint only after FPL has finalized the GW.
                  const event = await eventRepository.findById(season, targetEventId);
                  const finalizationDate = resolveRichResultFreshnessCutoff(event);
                  if (!finalizationDate) {
                    return { requiredEntryIds: entryIds, reusedUnits: 0 };
                  }
                  const freshAfter =
                    (await eventRepository.findDataCheckedAtExact(season, targetEventId)) ??
                    finalizationDate;
                  const requiredEntryIds =
                    await entryEventResultsRepository.findEntryIdsNeedingRichSync(
                      season,
                      entryIds,
                      targetEventId,
                      freshAfter,
                    );
                  return {
                    requiredEntryIds,
                    reusedUnits: entryIds.length - requiredEntryIds.length,
                  };
                },
              },
            );
          default:
            throw new Error(`Unknown entry-sync job: ${job.name}`);
        }
      };
      return runTrackedJob(context, async () => {
        const scoped = await withMutationScopes(
          {
            queueName: job.queueName,
            jobName: job.name,
            jobId,
            eventId: targetEventId,
            scopes: entryInfoScopes,
          },
          runMutation,
        );
        if (scoped.afterCommit) await scoped.afterCommit();
        const fence = effectiveJobData
          ? inspectSchedulerObligationFence(effectiveJobData)
          : { kind: 'none' as const };
        if (fence.kind === 'complete' && scoped.value.scanComplete) {
          await completeSchedulerObligation({
            obligationId: fence.obligationId,
            generation: fence.generation,
            status: 'succeeded',
            evidence: {
              queue: entrySyncQueueName,
              jobName: job.name,
              eventId: targetEventId,
              requiredUnits: scoped.value.requiredUnits,
              succeededUnits: scoped.value.succeededUnits,
              reusedUnits: scoped.value.reusedUnits,
            },
          });
        }
        return scoped.value;
      });
    });
  };

  const worker = new Worker<EntrySyncJobData>(entrySyncQueueName, processor, {
    connection,
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(entrySyncQueueName, { connection });

  worker.on('completed', (job) => {
    logInfo('Entry sync job completed', { jobId: job.id, name: job.name });
    const fence = inspectSchedulerObligationFence(job.data);
    if (job.id !== undefined && fence.kind === 'none') {
      void completeSchedulerObligationByBullJobId({
        bullJobId: job.id,
        evidence: { queue: entrySyncQueueName, jobName: job.name },
      }).catch(() => undefined);
    }
  });
  worker.on('failed', (job, error) => {
    logError('Entry sync job failed', error, {
      jobId: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
    });
    if (job) {
      void alertOnFinalFailure(job, error);
      const fence = inspectSchedulerObligationFence(job.data);
      if (isTerminalJobFailure(job, error) && fence.kind === 'complete') {
        void failSchedulerObligation({
          obligationId: fence.obligationId,
          generation: fence.generation,
          error,
        }).catch(() => undefined);
      } else if (
        job.id !== undefined &&
        isTerminalJobFailure(job, error) &&
        fence.kind === 'none'
      ) {
        void failSchedulerObligationByBullJobId({ bullJobId: job.id, error }).catch(
          () => undefined,
        );
      }
    }
  });

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: entrySyncQueue, queueEvents, queueName: entrySyncQueueName }],
  };
}
