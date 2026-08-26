import { databaseSingleton } from './db/singleton';
import { getConfig } from './utils/config';
import { startRuntimeHeartbeat } from './utils/runtime-heartbeat';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { logError, logInfo } from './utils/logger';
import { startQueueMonitor } from './utils/queue-monitor';
import { livePicksQueue, livePicksQueueName } from './queues/live-picks.queue';
import { createEntrySyncWorker } from './workers/entry-sync.worker';

/**
 * The live-picks queue contains a small root canary job and its entry-picks
 * fan-out. The entry worker owns both job names so a root cannot be marked
 * successful before its children have reached the scan finalizer. Bull
 * concurrency three is the internal entry cap; root jobs are event-scoped and
 * single-flight deduplicated by enqueueLivePicksRefresh.
 */
const config = getConfig();
if (config.NODE_ENV === 'production') await databaseSingleton.connect();

const runtime = createEntrySyncWorker({
  queue: livePicksQueue,
  queueName: livePicksQueueName,
  concurrency: 3,
  lane: 'live-picks',
});
const queueMonitors = runtime.monitorTargets.map((target) =>
  startQueueMonitor({
    queue: target.queue,
    queueEvents: target.queueEvents,
    queueName: target.queueName,
    consumerHeartbeatRole: 'livePicksWorker',
  }),
);
const stopHeartbeat = startWorkerHeartbeat({
  path: process.env.LIVE_PICKS_WORKER_HEARTBEAT_PATH ?? '/tmp/live-picks-worker-heartbeat',
});
const stopRuntimeHeartbeat = startRuntimeHeartbeat('livePicksWorker');

async function shutdown(signal: string) {
  logInfo('Live picks worker shutting down', { signal });
  stopHeartbeat();
  stopRuntimeHeartbeat();
  queueMonitors.forEach((monitor) => monitor.stop());
  await Promise.allSettled([
    ...runtime.workers.map((worker) => worker.close()),
    ...runtime.queueEvents.map((events) => events.close()),
    livePicksQueue.close(),
  ]);
  await databaseSingleton.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
const failFast = (message: string, error: unknown) => {
  // A fatal asynchronous error can leave Bull workers and the heartbeat loop
  // alive. Stop advertising this process as healthy and let Compose restart it
  // with a non-zero exit instead of accepting more work in an unknown state.
  stopHeartbeat();
  stopRuntimeHeartbeat();
  queueMonitors.forEach((monitor) => monitor.stop());
  logError(message, error);
  process.exitCode = 1;
  process.exit(1);
};
process.on('uncaughtException', (error) => failFast('Live picks worker uncaught exception', error));
process.on('unhandledRejection', (error) =>
  failFast('Live picks worker unhandled rejection', error),
);

logInfo('Live picks worker started', {
  queue: livePicksQueueName,
  concurrency: 3,
  rootConcurrency: 1,
  providerLimiter: 'shared-fpl-global',
});
