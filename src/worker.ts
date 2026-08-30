import { createDataSyncWorker } from './workers/data-sync.worker';
import { createFplCriticalSyncWorker } from './workers/fpl-critical-sync.worker';
import { createFplPriceWatchWorker } from './workers/fpl-price-watch.worker';
import { createEntrySyncWorker } from './workers/entry-sync.worker';
import { createLiveDataWorker } from './workers/live-data.worker';
import { createLeagueSyncWorker } from './workers/league-sync.worker';
import { createTournamentSyncWorker } from './workers/tournament-sync.worker';
import { createTournamentSetupWorker } from './workers/tournament-setup.worker';
import { createTournamentRepairWorker } from './workers/tournament-repair.worker';
import { createUnderstatWorker } from './workers/understat.worker';
import { createMaintenanceWorker } from './workers/maintenance.worker';
import { createDataGovernanceWorker } from './workers/data-governance.worker';
import { databaseSingleton } from './db/singleton';
import { redisSingleton } from './cache/singleton';
import { getConfig } from './utils/config';
import { startQueueMonitor } from './utils/queue-monitor';
import { logInfo } from './utils/logger';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { startRuntimeHeartbeat } from './utils/runtime-heartbeat';
import { closeUnderstatPermitClient } from './utils/understat-rate-limit';
import {
  drainWorkers,
  WORKER_SHUTDOWN_TIMEOUT_MS,
  type WorkerRuntime,
} from './workers/worker-runtime';
import { queueRedisSingleton } from './queues/redis';
import { closeAllProducerQueues } from './queues/close-all';
import { createShutdownController, installShutdownSignals } from './utils/shutdown-controller';

getConfig();

const config = getConfig();
if (config.NODE_ENV === 'production') {
  await databaseSingleton.connect();
}
const runtimes: WorkerRuntime[] = [
  createDataSyncWorker(),
  createFplCriticalSyncWorker(),
  createFplPriceWatchWorker(),
  createEntrySyncWorker(),
  createLiveDataWorker(),
  createLeagueSyncWorker(),
  createTournamentSyncWorker(),
  createTournamentSetupWorker(),
  createTournamentRepairWorker(),
  createUnderstatWorker(),
  createMaintenanceWorker(),
  createDataGovernanceWorker(),
];

const queueMonitors = runtimes.flatMap((runtime) =>
  runtime.monitorTargets.map((target) =>
    startQueueMonitor({
      queue: target.queue,
      queueEvents: target.queueEvents,
      queueName: target.queueName,
      consumerHeartbeatRole: 'queueWorker',
    }),
  ),
);
const allWorkers = runtimes.flatMap((runtime) => runtime.workers);
const allQueueEvents = runtimes.flatMap((runtime) => runtime.queueEvents);

// Docker healthcheck reads this file's mtime; a stale heartbeat means the
// event loop is hung even if the process is still alive.
const stopHeartbeat = startWorkerHeartbeat();
const stopRuntimeHeartbeat = startRuntimeHeartbeat('queueWorker');

const shutdownController = createShutdownController({
  timeoutMs: WORKER_SHUTDOWN_TIMEOUT_MS,
  stopIntake: () => {
    stopHeartbeat();
    stopRuntimeHeartbeat();
    queueMonitors.forEach((monitor) => monitor.stop());
    runtimes.forEach((runtime) => runtime.stop?.());
  },
  waitForInFlight: () => drainWorkers(allWorkers),
  closeMonitors: () =>
    Promise.all([
      ...allQueueEvents.map((events) => events.close()),
      closeUnderstatPermitClient(),
    ]).then(() => undefined),
  closeProducerQueues: closeAllProducerQueues,
  closeDatabase: () => databaseSingleton.disconnect(),
  closeCacheRedis: () => redisSingleton.disconnect(),
  closeQueueRedis: () => queueRedisSingleton.disconnect(),
});

installShutdownSignals(shutdownController);
process.on('uncaughtException', (error) =>
  shutdownController.fatal(error, 'Background worker uncaught exception'),
);
process.on('unhandledRejection', (error) =>
  shutdownController.fatal(error, 'Background worker unhandled rejection'),
);

logInfo('Background worker started', {
  mutationCoordination: 'postgresql-transaction-scoped',
});
