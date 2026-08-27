import { databaseSingleton } from './db/singleton';
import { redisSingleton } from './cache/singleton';
import { getConfig } from './utils/config';
import { startRuntimeHeartbeat } from './utils/runtime-heartbeat';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { logInfo } from './utils/logger';
import { startQueueMonitor } from './utils/queue-monitor';
import { closeLivePicksQueue, livePicksQueue, livePicksQueueName } from './queues/live-picks.queue';
import { queueRedisSingleton } from './queues/redis';
import { createEntrySyncWorker } from './workers/entry-sync.worker';
import { drainWorkers } from './workers/worker-runtime';
import { createShutdownController, installShutdownSignals } from './utils/shutdown-controller';

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

const shutdownController = createShutdownController({
  stopIntake: () => {
    stopHeartbeat();
    stopRuntimeHeartbeat();
    queueMonitors.forEach((monitor) => monitor.stop());
    runtime.stop?.();
  },
  waitForInFlight: () => drainWorkers(runtime.workers),
  closeResources: () =>
    Promise.all([
      ...runtime.queueEvents.map((events) => events.close()),
      closeLivePicksQueue(),
      databaseSingleton.disconnect(),
      redisSingleton.disconnect(),
      queueRedisSingleton.disconnect(),
    ]).then(() => undefined),
});

installShutdownSignals(shutdownController);
const failFast = (message: string, error: unknown) => {
  shutdownController.fatal(error, message);
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
