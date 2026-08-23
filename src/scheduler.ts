import { databaseSingleton } from './db/singleton';
import { getConfig } from './utils/config';
import { logError, logInfo } from './utils/logger';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { startRuntimeHeartbeat } from './utils/runtime-heartbeat';
import { runSchedulerPass } from './scheduler/scheduler.service';
import { dispatchDataPublicationOutbox } from './repositories/data-publication-outbox';
import { reconcileCoreAndMarketPublications } from './services/data-publication-reconciler';
import { seasonRepository } from './repositories/seasons';
import { persistLiveLifecycleStatus } from './services/live-lifecycle-orchestrator';

const SCHEDULER_INTERVAL_MS = 30_000;

getConfig();
if (getConfig().NODE_ENV === 'production') await databaseSingleton.connect();

const stopHeartbeat = startWorkerHeartbeat({
  path: process.env.SCHEDULER_HEARTBEAT_PATH ?? '/tmp/scheduler-heartbeat',
});
const stopRuntimeHeartbeat = startRuntimeHeartbeat('scheduler');
let inFlight: Promise<unknown> | null = null;

async function runIndependentSchedulerStage(
  stage: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    // Each independent recovery path is retried by the next pass and retains
    // its own durable evidence. One unavailable dependency must not suppress
    // the other repair stages for this 30-second cycle.
    logError('Scheduler stage failed; continuing independent recovery paths', error, { stage });
  }
}

async function runPass(): Promise<void> {
  if (inFlight) return inFlight.then(() => undefined);
  const pass = (async () => {
    const now = new Date();
    const season = await seasonRepository.findCurrent();
    await runIndependentSchedulerStage('core-market-publication-reconcile', () =>
      reconcileCoreAndMarketPublications(season),
    );
    await runIndependentSchedulerStage('data-publication-outbox', () =>
      dispatchDataPublicationOutbox({ limit: 20 }),
    );
    await runIndependentSchedulerStage('live-lifecycle', () => persistLiveLifecycleStatus(now));
    await runIndependentSchedulerStage('obligation-registry', () => runSchedulerPass(now));
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
