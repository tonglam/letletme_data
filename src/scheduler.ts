import { databaseSingleton } from './db/singleton';
import { getConfig } from './utils/config';
import { logError, logInfo } from './utils/logger';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { startRuntimeHeartbeat } from './utils/runtime-heartbeat';
import { runSchedulerPass } from './scheduler/scheduler.service';
import { dispatchDataPublicationOutbox } from './repositories/data-publication-outbox';
import { reconcileCoreAndMarketPublications } from './services/data-publication-reconciler';
import { seasonRepository } from './repositories/seasons';

const SCHEDULER_INTERVAL_MS = 30_000;

getConfig();
if (getConfig().NODE_ENV === 'production') await databaseSingleton.connect();

const stopHeartbeat = startWorkerHeartbeat({
  path: process.env.SCHEDULER_HEARTBEAT_PATH ?? '/tmp/scheduler-heartbeat',
});
const stopRuntimeHeartbeat = startRuntimeHeartbeat('scheduler');
let inFlight: Promise<unknown> | null = null;

async function runPass(): Promise<void> {
  if (inFlight) return inFlight.then(() => undefined);
  const pass = (async () => {
    const season = await seasonRepository.findCurrent();
    await reconcileCoreAndMarketPublications(season);
    await dispatchDataPublicationOutbox({ limit: 20 });
    await runSchedulerPass();
  })()
    .catch((error) => logError('Scheduler reconciliation pass failed', error))
    .finally(() => {
      inFlight = null;
    });
  inFlight = pass;
  await pass;
}

await runPass();
const timer = setInterval(() => void runPass(), SCHEDULER_INTERVAL_MS);
timer.unref?.();

async function shutdown(signal: string): Promise<void> {
  logInfo('Scheduler shutting down', { signal });
  clearInterval(timer);
  stopHeartbeat();
  stopRuntimeHeartbeat();
  await inFlight;
  await databaseSingleton.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

logInfo('Scheduler process ready', {
  intervalMs: SCHEDULER_INTERVAL_MS,
  registry: 'single-scheduled-job-definition-registry',
});
