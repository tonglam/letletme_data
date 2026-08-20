import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

import { databaseSingleton, getDb } from './db/singleton';
import {
  contentAcquisitionCheckpoints,
  contentAcquisitionRuns,
  contentSourceGroups,
} from './db/schemas/content.schema';
import { getContentRuntimeFlags } from './content/config';
import {
  enqueueContentXScan,
  createContentXWorkerRuntime,
  closeContentXQueue,
} from './content/workers/content-x.queue';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { logError, logInfo } from './utils/logger';
import { withMutationConflictGuard } from './utils/mutation-lock';
import { computePollWindow, isPollDue, pollBudget, resolvePollPhase } from './content/poll-policy';
import {
  confirmAcquisitionRunEnqueued,
  reclaimStaleAcquisitionRuns,
  reservePendingAcquisitionRun,
} from './content/acquisition/run-repository';
import { buildSourceSnapshot } from './content/acquisition/source-registry';
import { dispatchPublicationOutbox } from './content/publication/revalidation';

const flags = getContentRuntimeFlags();
const partitionKey = process.env.CONTENT_PARTITION_KEY?.trim() || 'week';
const runtime = createContentXWorkerRuntime();
const stopHeartbeat = startWorkerHeartbeat({
  path: process.env.WORKER_HEARTBEAT_PATH ?? '/tmp/content-worker-heartbeat',
});
let scheduler: ReturnType<typeof setInterval> | null = null;
let publicationOutboxDispatcher: ReturnType<typeof setInterval> | null = null;
let publicationOutboxDispatchInFlight: Promise<void> | null = null;

const PUBLICATION_OUTBOX_DISPATCH_INTERVAL_MS = 30_000;

async function dispatchPendingPublicationOutbox(): Promise<void> {
  if (publicationOutboxDispatchInFlight) return publicationOutboxDispatchInFlight;

  const dispatch = dispatchPublicationOutbox()
    .then((delivered) => {
      if (delivered > 0) {
        logInfo('Publication outbox rows delivered', { delivered });
      }
    })
    .catch((error) => {
      logError('Publication outbox dispatch pass failed; rows remain pending', error);
    })
    .finally(() => {
      publicationOutboxDispatchInFlight = null;
    });
  publicationOutboxDispatchInFlight = dispatch;
  return dispatch;
}

async function scheduleFromDatabase(): Promise<void> {
  if (!flags.pipelineEnabled) return;
  const db = await getDb();
  const groups = await db
    .select({
      groupId: contentSourceGroups.groupId,
      groupKey: contentSourceGroups.groupKey,
      pollPolicy: contentSourceGroups.pollPolicy,
    })
    .from(contentSourceGroups)
    .where(eq(contentSourceGroups.status, 'active'));
  const now = new Date();
  for (const group of groups) {
    const reservation = await withMutationConflictGuard(
      {
        queueName: 'content-x-scheduler',
        jobName: 'content-x-poll',
        scopes: [`content-x-poll:${group.groupId}:${partitionKey}`],
      },
      async () => {
        const transactionDb = await getDb();
        const phase = resolvePollPhase(group.pollPolicy, now);
        await reclaimStaleAcquisitionRuns({
          groupId: group.groupId,
          partitionKey,
          mode: 'poll',
          now,
        });
        const [checkpoints, activeRuns] = await Promise.all([
          transactionDb
            .select({ windowEnd: contentAcquisitionCheckpoints.windowEnd })
            .from(contentAcquisitionCheckpoints)
            .where(
              and(
                eq(contentAcquisitionCheckpoints.groupId, group.groupId),
                eq(contentAcquisitionCheckpoints.partitionKey, partitionKey),
              ),
            )
            .limit(1),
          transactionDb
            .select({ runId: contentAcquisitionRuns.runId })
            .from(contentAcquisitionRuns)
            .where(
              and(
                eq(contentAcquisitionRuns.groupId, group.groupId),
                eq(contentAcquisitionRuns.partitionKey, partitionKey),
                eq(contentAcquisitionRuns.mode, 'poll'),
                inArray(contentAcquisitionRuns.status, ['pending', 'running']),
              ),
            )
            .limit(1),
        ]);
        const checkpointEnd = checkpoints[0]?.windowEnd ?? null;
        if (
          activeRuns.length > 0 ||
          !isPollDue({ policy: group.pollPolicy, phase, now, checkpointEnd })
        )
          return null;
        const window = computePollWindow({
          policy: group.pollPolicy,
          phase,
          now,
          checkpointEnd,
        });
        const end = window.windowEnd.toISOString();
        const start = window.windowStart.toISOString();
        const snapshot = await buildSourceSnapshot(group.groupKey);
        if (snapshot.items.length === 0) {
          logInfo('Content scheduler skipped empty source group', {
            groupKey: group.groupKey,
            partitionKey,
          });
          return null;
        }
        const runId = randomUUID();
        const idempotencyKey = `briefing:x:${group.groupKey}:${partitionKey}:poll:${phase}:${end}`;
        const pending = await reservePendingAcquisitionRun({
          runId,
          groupId: group.groupId,
          partitionKey,
          mode: 'poll',
          windowStart: start,
          windowEnd: end,
          idempotencyKey,
        });
        return { pending, runId, phase, start, end, idempotencyKey };
      },
    );
    if (!reservation || reservation.pending.reused) continue;
    try {
      await enqueueContentXScan({
        runId: reservation.runId,
        idempotencyKey: reservation.idempotencyKey,
        groupKey: group.groupKey,
        partitionKey,
        mode: 'poll',
        pollPhase: reservation.phase,
        phaseBudget: pollBudget(group.pollPolicy, reservation.phase),
        windowStart: reservation.start,
        windowEnd: reservation.end,
      });
      await confirmAcquisitionRunEnqueued(reservation.runId);
    } catch (error) {
      logError('Content scheduler enqueue failed; pending run will be reclaimed', error, {
        runId: reservation.runId,
        groupKey: group.groupKey,
        partitionKey,
      });
    }
  }
}

if (flags.pipelineEnabled) {
  void scheduleFromDatabase().catch((error) =>
    logError('Content scheduler initial pass failed', error),
  );
  scheduler = setInterval(() => {
    void scheduleFromDatabase().catch((error) => logError('Content scheduler pass failed', error));
  }, 30_000);
  scheduler.unref?.();
}

// Publication revalidation is an independent delivery concern. Keep retrying
// pending rows even when no new edition is published; the content worker is a
// long-running service in every environment and the dispatcher is a no-op
// until the revalidation URL and secret are configured.
void dispatchPendingPublicationOutbox();
publicationOutboxDispatcher = setInterval(() => {
  void dispatchPendingPublicationOutbox();
}, PUBLICATION_OUTBOX_DISPATCH_INTERVAL_MS);
publicationOutboxDispatcher.unref?.();

async function shutdown(signal: string): Promise<void> {
  logInfo('Content worker shutting down', { signal });
  if (scheduler) clearInterval(scheduler);
  if (publicationOutboxDispatcher) clearInterval(publicationOutboxDispatcher);
  stopHeartbeat();
  await Promise.allSettled([
    publicationOutboxDispatchInFlight,
    runtime.worker.close(),
    runtime.queueEvents.close(),
    closeContentXQueue(),
    databaseSingleton.disconnect(),
  ]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

logInfo('Content X worker ready', {
  pipelineEnabled: flags.pipelineEnabled,
  realGrokEnabled: flags.realGrokEnabled,
  concurrency: flags.grokConcurrency,
  queue: 'content-x-scan',
});
