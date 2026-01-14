import { createDataSyncWorker } from './workers/data-sync.worker';
import { createEntrySyncWorker } from './workers/entry-sync.worker';
import { getConfig } from './utils/config';
import { logInfo } from './utils/logger';

getConfig();

const { worker: dataSyncWorker, queueEvents: dataSyncEvents } = createDataSyncWorker();
const { worker: entrySyncWorker, queueEvents: entrySyncEvents } = createEntrySyncWorker();

async function shutdown(signal: string) {
  logInfo('Worker shutting down', { signal });
  await Promise.allSettled([
    dataSyncWorker.close(),
    dataSyncEvents.close(),
    entrySyncWorker.close(),
    entrySyncEvents.close(),
  ]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

logInfo('Background worker started');
