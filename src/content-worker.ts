import { logInfo, logError } from './utils/logger';
import { runContentXWorker } from './content/workers/content-x.worker';

runContentXWorker()
  .then(() => logInfo('Content X worker ready'))
  .catch((error) => {
    logError('Content X worker failed to start', error);
    process.exitCode = 1;
  });
