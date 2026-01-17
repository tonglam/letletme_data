import { createDataSyncWorker } from './workers/data-sync.worker';
import { createEntrySyncWorker } from './workers/entry-sync.worker';
import { liveDataWorker } from './workers/live-data.worker';
import { leagueSyncWorker } from './workers/league-sync.worker';
import { tournamentSyncWorker } from './workers/tournament-sync.worker';
import { dataSyncQueue } from './queues/data-sync.queue';
import { entrySyncQueue } from './queues/entry-sync.queue';
import { liveDataQueue } from './queues/live-data.queue';
import { leagueSyncQueue } from './queues/league-sync.queue';
import { tournamentSyncQueue } from './queues/tournament-sync.queue';
import { getConfig } from './utils/config';
import { startQueueMonitor } from './utils/queue-monitor';
import { logInfo } from './utils/logger';

getConfig();

const { worker: dataSyncWorker, queueEvents: dataSyncEvents } = createDataSyncWorker();
const { worker: entrySyncWorker, queueEvents: entrySyncEvents } = createEntrySyncWorker();

const dataSyncMonitor = startQueueMonitor({
  queue: dataSyncQueue,
  queueEvents: dataSyncEvents,
});
const entrySyncMonitor = startQueueMonitor({
  queue: entrySyncQueue,
  queueEvents: entrySyncEvents,
});

logInfo('Live data worker initialized');
logInfo('League sync worker initialized');
logInfo('Tournament sync worker initialized');

async function shutdown(signal: string) {
  logInfo('Worker shutting down', { signal });
  await Promise.allSettled([
    dataSyncWorker.close(),
    dataSyncEvents.close(),
    entrySyncWorker.close(),
    entrySyncEvents.close(),
    liveDataWorker.close(),
    liveDataQueue.close(),
    leagueSyncWorker.close(),
    leagueSyncQueue.close(),
    tournamentSyncWorker.close(),
    tournamentSyncQueue.close(),
  ]);
  dataSyncMonitor.stop();
  entrySyncMonitor.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

logInfo('Background worker started');
