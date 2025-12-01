import { createDataSyncWorker } from './workers/data-sync.worker';
import { getConfig } from './utils/config';
import { logInfo } from './utils/logger';

getConfig();

const { worker, queueEvents } = createDataSyncWorker();

async function shutdown(signal: string) {
  logInfo('Worker shutting down', { signal });
  await Promise.allSettled([worker.close(), queueEvents.close()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

logInfo('Background worker started');
