import { QueueEvents, Worker, type Job } from 'bullmq';
import { and, asc, eq, gt } from 'drizzle-orm';

import { MUTATION_PRIORITY_ORDER, type MutationPriorityTier } from '../domain/job-priority';
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
  entrySyncQueuesByTier,
  getEntrySyncQueueName,
  isEntrySyncTieredQueueEnabled,
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
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { IncompleteDataSyncError } from '../utils/errors';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import { getQueueConnection } from '../utils/queue';
import { startStrictPriorityGate } from './strict-priority-gate';
import type { WorkerRuntime } from './worker-runtime';

const maxRetryCycles = 2;
const retryBaseDelayMs = 5 * 60_000;
const retryMaxDelayMs = 30 * 60_000;

interface LoadedEntryIds {
  entryIds: number[];
  hasMore: boolean;
  lastEntryId: number | null;
  chunkSize: number;
  chunkOffset: number;
  fetchedFromDb: boolean;
}

interface SyncEntriesOptions {
  concurrency: number;
  throttleMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function loadEntryIdsForSync(
  season: FplSeasonRef,
  jobData?: EntrySyncJobData,
): Promise<LoadedEntryIds> {
  const chunkSize = jobData?.chunkSize ?? ENTRY_SYNC_DEFAULT_CHUNK_SIZE;
  const chunkOffset = jobData?.chunkOffset ?? 0;

  if (jobData?.entryIds && jobData.entryIds.length > 0) {
    const entryIds = Array.from(new Set(jobData.entryIds));
    return {
      entryIds,
      hasMore: false,
      lastEntryId: null,
      chunkSize,
      chunkOffset,
      fetchedFromDb: false,
    };
  }

  const db = await getDb();
  const rows =
    jobData?.afterEntryId !== undefined
      ? await db
          .select({ id: entriesInCompetition.entryId })
          .from(entriesInCompetition)
          .where(
            and(
              eq(entriesInCompetition.seasonId, season.seasonId),
              gt(entriesInCompetition.entryId, jobData.afterEntryId),
            ),
          )
          .orderBy(asc(entriesInCompetition.entryId))
          .limit(chunkSize)
      : await db
          .select({ id: entriesInCompetition.entryId })
          .from(entriesInCompetition)
          .where(eq(entriesInCompetition.seasonId, season.seasonId))
          .orderBy(asc(entriesInCompetition.entryId))
          .limit(chunkSize)
          .offset(chunkOffset);

  const ids = rows.map((row) => row.id);
  return {
    entryIds: ids,
    hasMore: ids.length === chunkSize,
    lastEntryId: ids.at(-1) ?? null,
    chunkSize,
    chunkOffset,
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
  const delayMultiplier = Math.max(retryCount, 1);
  const delayMs = Math.min(retryBaseDelayMs * delayMultiplier, retryMaxDelayMs);

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

async function handleEntryJob(
  season: FplSeasonRef,
  jobName: EntrySyncJobName,
  label: string,
  handler: (entryId: number) => Promise<unknown>,
  jobData?: EntrySyncJobData,
  options: HandleEntryJobOptions = {},
) {
  const loaded = await loadEntryIdsForSync(season, jobData);
  if (loaded.entryIds.length === 0) {
    logInfo(`No entries found for ${label}`, {
      jobName,
      chunkOffset: loaded.chunkOffset,
    });
    return {
      total: 0,
      success: 0,
      failed: 0,
      failedIds: [] as number[],
      hasMore: false,
      fetchedFromDb: loaded.fetchedFromDb,
      scanComplete: loaded.fetchedFromDb,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
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

    return {
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
  }

  const scanComplete = loaded.fetchedFromDb && decision.action === 'complete';
  return {
    ...result,
    total: loaded.entryIds.length,
    hasMore: decision.action === 'continue_scan',
    fetchedFromDb: loaded.fetchedFromDb,
    scanComplete,
    requiredUnits: selection.requiredEntryIds.length,
    reusedUnits: selection.reusedUnits,
    succeededUnits: result.success,
    failedUnits: result.failed,
  };
}

export function createEntrySyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const activeTiers = isEntrySyncTieredQueueEnabled ? MUTATION_PRIORITY_ORDER : (['p2'] as const);
  const workers: Worker<EntrySyncJobData>[] = [];
  const queueEvents: QueueEvents[] = [];
  const monitorTargets: WorkerRuntime['monitorTargets'] = [];

  const processor = async (job: Job<EntrySyncJobData>) => {
    const season = await requireCurrentSeasonForJob(job.data);
    const jobId = job.id ?? `${job.name}-${job.timestamp}`;
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
      return withMutationConflictGuard(
        {
          queueName: job.queueName,
          jobName: job.name,
          jobId,
          eventId: targetEventId,
        },
        () =>
          runTrackedJob(context, async () => {
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
                if (
                  effectiveJobData?.source === 'cron' &&
                  shouldMarkEntryInfoSynced(result.fetchedFromDb, result.hasMore, result.failed)
                ) {
                  await markEntryInfoSyncedToday(new Date(), job.id);
                }
                return result;
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
          }),
      );
    });
  };

  for (const tier of activeTiers) {
    const queueName = getEntrySyncQueueName(tier);
    const worker = new Worker<EntrySyncJobData>(queueName, processor, {
      connection,
      lockDuration: 120_000,
      maxStalledCount: 2,
      stalledInterval: 15_000,
    });
    const events = new QueueEvents(queueName, { connection });

    worker.on('completed', (job) => {
      logInfo('Entry sync job completed', { jobId: job.id, name: job.name, tier });
    });

    worker.on('failed', (job, error) => {
      logError('Entry sync job failed', error, {
        jobId: job?.id,
        name: job?.name,
        attemptsMade: job?.attemptsMade,
        tier,
      });
      if (job) {
        void alertOnFinalFailure(job, error);
      }
    });

    workers.push(worker);
    queueEvents.push(events);
    monitorTargets.push({
      queue: entrySyncQueuesByTier[tier],
      queueEvents: events,
      queueName,
      tier,
    });
  }

  const workerByTier = buildWorkerTierMap(workers, activeTiers);
  const gate = startStrictPriorityGate(
    'entry-sync',
    {
      p0: { queue: entrySyncQueuesByTier.p0, worker: workerByTier.p0 },
      p1: { queue: entrySyncQueuesByTier.p1, worker: workerByTier.p1 },
      p2: { queue: entrySyncQueuesByTier.p2, worker: workerByTier.p2 },
      p3: { queue: entrySyncQueuesByTier.p3, worker: workerByTier.p3 },
    },
    { enabled: isEntrySyncTieredQueueEnabled },
  );

  return { workers, queueEvents, monitorTargets, stop: gate.stop };
}

function buildWorkerTierMap(
  workers: Worker<EntrySyncJobData>[],
  activeTiers: readonly MutationPriorityTier[],
): Record<MutationPriorityTier, Worker<EntrySyncJobData>> {
  const fallback = workers[0];
  const workerByTier = {} as Record<MutationPriorityTier, Worker<EntrySyncJobData>>;
  for (const tier of MUTATION_PRIORITY_ORDER) {
    const index = activeTiers.indexOf(tier);
    workerByTier[tier] = index >= 0 ? workers[index] : fallback;
  }
  return workerByTier;
}
