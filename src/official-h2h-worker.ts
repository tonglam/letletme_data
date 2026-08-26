import { databaseSingleton } from './db/singleton';
import { getConfig } from './utils/config';
import { startRuntimeHeartbeat } from './utils/runtime-heartbeat';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { logInfo } from './utils/logger';
import { officialH2hLiveQueue, officialH2hLiveQueueName } from './queues/official-h2h-live.queue';
import { createTournamentSyncWorker } from './workers/tournament-sync.worker';
import { startQueueMonitor } from './utils/queue-monitor';

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

async function shutdown(signal: string) {
  logInfo('Official H2H worker shutting down', { signal });
  stopHeartbeat();
  stopRuntimeHeartbeat();
  queueMonitors.forEach((monitor) => monitor.stop());
  await Promise.allSettled([
    ...runtime.workers.map((worker) => worker.close()),
    ...runtime.queueEvents.map((events) => events.close()),
    officialH2hLiveQueue.close(),
  ]);
  await databaseSingleton.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
logInfo('Official H2H worker started', { queue: officialH2hLiveQueueName, concurrency: 1 });
