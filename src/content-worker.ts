import { and, eq } from 'drizzle-orm';

import { databaseSingleton, getDb } from './db/singleton';
import { contentAcquisitionCheckpoints, contentSourceGroups } from './db/schemas/content.schema';
import { getContentRuntimeFlags } from './content/config';
import {
  enqueueContentXScan,
  createContentXWorkerRuntime,
  closeContentXQueue,
} from './content/workers/content-x.queue';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { logError, logInfo } from './utils/logger';
import { computePollWindow, resolvePollPhase } from './content/poll-policy';

const flags = getContentRuntimeFlags();
const runtime = createContentXWorkerRuntime();
const stopHeartbeat = startWorkerHeartbeat({
  path: process.env.WORKER_HEARTBEAT_PATH ?? '/tmp/content-worker-heartbeat',
});
let scheduler: ReturnType<typeof setInterval> | null = null;

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
    const phase = resolvePollPhase(group.pollPolicy, now);
    const checkpoints = await db
      .select({ windowEnd: contentAcquisitionCheckpoints.windowEnd })
      .from(contentAcquisitionCheckpoints)
      .where(
        and(
          eq(contentAcquisitionCheckpoints.groupId, group.groupId),
          eq(contentAcquisitionCheckpoints.partitionKey, 'week'),
        ),
      )
      .limit(1);
    const window = computePollWindow({
      policy: group.pollPolicy,
      phase,
      now,
      checkpointEnd: checkpoints[0]?.windowEnd ?? null,
    });
    const end = window.windowEnd.toISOString();
    const start = window.windowStart.toISOString();
    await enqueueContentXScan({
      groupKey: group.groupKey,
      partitionKey: 'week',
      mode: 'poll',
      pollPhase: phase,
      windowStart: start,
      windowEnd: end,
    });
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

async function shutdown(signal: string): Promise<void> {
  logInfo('Content worker shutting down', { signal });
  if (scheduler) clearInterval(scheduler);
  stopHeartbeat();
  await Promise.allSettled([
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
  concurrency: 1,
  queue: 'content-x-scan',
});
