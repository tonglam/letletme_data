import { databaseSingleton } from './db/singleton';
import { redisSingleton } from './cache/singleton';
import { getConfig } from './utils/config';
import { startRuntimeHeartbeat } from './utils/runtime-heartbeat';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { logInfo } from './utils/logger';
import {
  closeOfficialH2HLiveQueue,
  officialH2hLiveQueue,
  officialH2hLiveQueueName,
} from './queues/official-h2h-live.queue';
import { createTournamentSyncWorker } from './workers/tournament-sync.worker';
import { startQueueMonitor } from './utils/queue-monitor';
import { queueRedisSingleton } from './queues/redis';
import { createShutdownController, installShutdownSignals } from './utils/shutdown-controller';

const config = getConfig();
if (config.NODE_ENV === 'production') await databaseSingleton.connect();

const runtime = createTournamentSyncWorker({
  queue: officialH2hLiveQueue,
  queueName: officialH2hLiveQueueName,
  concurrency: 1,
});
const queueMonitors = runtime.monitorTargets.map((target) =>
  startQueueMonitor({
    queue: target.queue,
    queueEvents: target.queueEvents,
    queueName: target.queueName,
    consumerHeartbeatRole: 'officialH2HWorker',
  }),
);
const stopHeartbeat = startWorkerHeartbeat({
  path: process.env.OFFICIAL_H2H_WORKER_HEARTBEAT_PATH ?? '/tmp/official-h2h-worker-heartbeat',
});
const stopRuntimeHeartbeat = startRuntimeHeartbeat('officialH2HWorker');

const shutdownController = createShutdownController({
  stopIntake: () => {
    stopHeartbeat();
    stopRuntimeHeartbeat();
    queueMonitors.forEach((monitor) => monitor.stop());
    runtime.stop?.();
  },
  waitForInFlight: () =>
    Promise.all(runtime.workers.map((worker) => worker.close())).then(() => undefined),
  closeResources: () =>
    Promise.all([
      ...runtime.queueEvents.map((events) => events.close()),
      closeOfficialH2HLiveQueue(),
      databaseSingleton.disconnect(),
      redisSingleton.disconnect(),
      queueRedisSingleton.disconnect(),
    ]).then(() => undefined),
});

installShutdownSignals(shutdownController);
process.on('uncaughtException', (error) =>
  shutdownController.fatal(error, 'Official H2H worker uncaught exception'),
);
process.on('unhandledRejection', (error) =>
  shutdownController.fatal(error, 'Official H2H worker unhandled rejection'),
);
logInfo('Official H2H worker started', { queue: officialH2hLiveQueueName, concurrency: 1 });
