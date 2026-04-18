import { createDataSyncWorker } from './workers/data-sync.worker';
import { createEntrySyncWorker } from './workers/entry-sync.worker';
import { createLiveDataWorker } from './workers/live-data.worker';
import { createLeagueSyncWorker } from './workers/league-sync.worker';
import { createTournamentSyncWorker } from './workers/tournament-sync.worker';
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
const { worker: liveDataWorker, queueEvents: liveDataEvents } = createLiveDataWorker();
const { worker: leagueSyncWorker, queueEvents: leagueSyncEvents } = createLeagueSyncWorker();
const { worker: tournamentSyncWorker, queueEvents: tournamentSyncEvents } =
  createTournamentSyncWorker();

const dataSyncMonitor = startQueueMonitor({ queue: dataSyncQueue, queueEvents: dataSyncEvents });
const entrySyncMonitor = startQueueMonitor({ queue: entrySyncQueue, queueEvents: entrySyncEvents });
const liveDataMonitor = startQueueMonitor({ queue: liveDataQueue, queueEvents: liveDataEvents });
const leagueSyncMonitor = startQueueMonitor({
  queue: leagueSyncQueue,
  queueEvents: leagueSyncEvents,
});
const tournamentSyncMonitor = startQueueMonitor({
  queue: tournamentSyncQueue,
  queueEvents: tournamentSyncEvents,
});

async function shutdown(signal: string) {
  logInfo('Worker shutting down', { signal });
  await Promise.allSettled([
    dataSyncWorker.close(),
    dataSyncEvents.close(),
    entrySyncWorker.close(),
    entrySyncEvents.close(),
    liveDataWorker.close(),
    liveDataEvents.close(),
    liveDataQueue.close(),
    leagueSyncWorker.close(),
    leagueSyncEvents.close(),
    leagueSyncQueue.close(),
    tournamentSyncWorker.close(),
    tournamentSyncEvents.close(),
    tournamentSyncQueue.close(),
  ]);
  dataSyncMonitor.stop();
  entrySyncMonitor.stop();
  liveDataMonitor.stop();
  leagueSyncMonitor.stop();
  tournamentSyncMonitor.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

logInfo('Background worker started');
