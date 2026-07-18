import { createDataSyncWorker } from './workers/data-sync.worker';
import { createEntrySyncWorker } from './workers/entry-sync.worker';
import { createLiveDataWorker } from './workers/live-data.worker';
import { createLeagueSyncWorker } from './workers/league-sync.worker';
import { createTournamentSyncWorker } from './workers/tournament-sync.worker';
import { createTournamentSetupWorker } from './workers/tournament-setup.worker';
import { getConfig } from './utils/config';
import { startQueueMonitor } from './utils/queue-monitor';
import { logInfo } from './utils/logger';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import type { WorkerRuntime } from './workers/worker-runtime';

getConfig();

const config = getConfig();
const mutationConflictGuardEnabled = config.ENABLE_MUTATION_CONFLICT_GUARD;
const tieredMutationQueuesEnabled = config.ENABLE_TIERED_MUTATION_QUEUES;
const mutationLockConfig = {
  ttlMs: config.MUTATION_LOCK_TTL_MS,
  waitTimeoutMs: config.MUTATION_LOCK_WAIT_TIMEOUT_MS,
  retryDelayMs: config.MUTATION_LOCK_RETRY_DELAY_MS,
  heartbeatMs: config.MUTATION_LOCK_HEARTBEAT_MS,
};

const runtimes: WorkerRuntime[] = [
  createDataSyncWorker(),
  createEntrySyncWorker(),
  createLiveDataWorker(),
  createLeagueSyncWorker(),
  createTournamentSyncWorker(),
  createTournamentSetupWorker(),
];

const queueMonitors = runtimes.flatMap((runtime) =>
  runtime.monitorTargets.map((target) =>
    startQueueMonitor({
      queue: target.queue,
      queueEvents: target.queueEvents,
      queueName: target.queueName,
      tier: target.tier,
    }),
  ),
);
const allWorkers = runtimes.flatMap((runtime) => runtime.workers);
const allQueueEvents = runtimes.flatMap((runtime) => runtime.queueEvents);

// Docker healthcheck reads this file's mtime; a stale heartbeat means the
// event loop is hung even if the process is still alive.
const stopHeartbeat = startWorkerHeartbeat();

async function shutdown(signal: string) {
  logInfo('Worker shutting down', { signal });
  stopHeartbeat();
  queueMonitors.forEach((monitor) => monitor.stop());
  runtimes.forEach((runtime) => runtime.stop?.());
  await Promise.allSettled([
    ...allWorkers.map((worker) => worker.close()),
    ...allQueueEvents.map((events) => events.close()),
  ]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

logInfo('Background worker started', {
  mutationConflictGuardEnabled,
  tieredMutationQueuesEnabled,
  mutationLockConfig,
});
