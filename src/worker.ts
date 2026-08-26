import { createDataSyncWorker } from './workers/data-sync.worker';
import { createFplCriticalSyncWorker } from './workers/fpl-critical-sync.worker';
import { createEntrySyncWorker } from './workers/entry-sync.worker';
import { createLiveDataWorker } from './workers/live-data.worker';
import { createManagerLiveWorker } from './workers/manager-live.worker';
import { createLeagueSyncWorker } from './workers/league-sync.worker';
import { createTournamentSyncWorker } from './workers/tournament-sync.worker';
import { createTournamentSetupWorker } from './workers/tournament-setup.worker';
import { createTournamentRepairWorker } from './workers/tournament-repair.worker';
import { createUnderstatWorker } from './workers/understat.worker';
import { createMaintenanceWorker } from './workers/maintenance.worker';
import { databaseSingleton } from './db/singleton';
import { getConfig } from './utils/config';
import { startQueueMonitor } from './utils/queue-monitor';
import { logError, logInfo } from './utils/logger';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { startRuntimeHeartbeat } from './utils/runtime-heartbeat';
import { closeUnderstatPermitClient } from './utils/understat-rate-limit';
import { WORKER_SHUTDOWN_TIMEOUT_MS, type WorkerRuntime } from './workers/worker-runtime';

getConfig();

const config = getConfig();
if (config.NODE_ENV === 'production') {
  await databaseSingleton.connect();
}
const runtimes: WorkerRuntime[] = [
  createDataSyncWorker(),
  createFplCriticalSyncWorker(),
  createEntrySyncWorker(),
  createLiveDataWorker(),
  createManagerLiveWorker(),
  createLeagueSyncWorker(),
  createTournamentSyncWorker(),
  createTournamentSetupWorker(),
  createTournamentRepairWorker(),
  createUnderstatWorker(),
  createMaintenanceWorker(),
];

const queueMonitors = runtimes.flatMap((runtime) =>
  runtime.monitorTargets.map((target) =>
    startQueueMonitor({
      queue: target.queue,
      queueEvents: target.queueEvents,
      queueName: target.queueName,
    }),
  ),
);
const allWorkers = runtimes.flatMap((runtime) => runtime.workers);
const allQueueEvents = runtimes.flatMap((runtime) => runtime.queueEvents);

// Docker healthcheck reads this file's mtime; a stale heartbeat means the
// event loop is hung even if the process is still alive.
const stopHeartbeat = startWorkerHeartbeat();
const stopRuntimeHeartbeat = startRuntimeHeartbeat('queueWorker');

async function shutdown(signal: string) {
  logInfo('Worker shutting down', { signal });
  stopHeartbeat();
  stopRuntimeHeartbeat();
  queueMonitors.forEach((monitor) => monitor.stop());
  runtimes.forEach((runtime) => runtime.stop?.());

  const closeAll = Promise.allSettled([
    ...allWorkers.map((worker) => worker.close()),
    ...allQueueEvents.map((events) => events.close()),
    closeUnderstatPermitClient(),
  ]);

  const timeout = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('Shutdown timed out')), WORKER_SHUTDOWN_TIMEOUT_MS).unref?.();
  });

  try {
    await Promise.race([closeAll, timeout]);
  } catch (error) {
    logError('Worker shutdown did not complete within timeout; exiting uncleanly', error);
    process.exit(1);
  }

  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

logInfo('Background worker started', {
  mutationCoordination: 'postgresql-transaction-scoped',
});
