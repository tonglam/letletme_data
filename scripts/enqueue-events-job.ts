import 'dotenv/config';

import { enqueueEventsSyncJob } from '../src/jobs/data-sync.queue';
import { closeDataSyncQueue } from '../src/queues/data-sync.queue';
import { logInfo, logError } from '../src/utils/logger';

async function main() {
  const timeout = setTimeout(() => {
    logError('Timed out enqueueing events job');
    process.exit(1);
  }, 10_000);

  try {
    const job = await enqueueEventsSyncJob('manual');
    clearTimeout(timeout);
    logInfo('Events sync job enqueued via script', { jobId: job.id });
  } catch (error) {
    clearTimeout(timeout);
    logError('Failed to enqueue events sync job via script', error);
    process.exit(1);
  } finally {
    await closeDataSyncQueue().catch((error) => {
      logError('Failed to close data sync queue', error);
    });
  }
}

main();
