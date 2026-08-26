import { databaseSingleton } from './db/singleton';
import { getConfig } from './utils/config';
import { logError, logInfo } from './utils/logger';
import { touchWorkerHeartbeat } from './utils/worker-heartbeat';
import { startRuntimeHeartbeat } from './utils/runtime-heartbeat';
import { runSchedulerPass } from './scheduler/scheduler.service';
import { seasonRepository } from './repositories/seasons';
import { enqueueDataGovernanceJob, DATA_GOVERNANCE_JOBS } from './jobs/data-governance.jobs';
import { enqueueMaintenanceJob } from './jobs/maintenance.jobs';
import { MAINTENANCE_JOBS } from './queues/maintenance.queue';
import { QueueDrainOnlyError } from './services/queue-governance.service';

const SCHEDULER_INTERVAL_MS = 30_000;

getConfig();
if (getConfig().NODE_ENV === 'production') await databaseSingleton.connect();

const schedulerHeartbeatPath = process.env.SCHEDULER_HEARTBEAT_PATH ?? '/tmp/scheduler-heartbeat';
const stopHeartbeat = () => undefined;
const stopRuntimeHeartbeat = startRuntimeHeartbeat('scheduler');
let inFlight: Promise<unknown> | null = null;

async function runIndependentSchedulerStage<T>(
  stage: string,
  operation: () => Promise<T>,
  state?: { failed: boolean },
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    // Each independent recovery path is retried by the next pass and retains
    // its own durable evidence. One unavailable dependency must not suppress
    // the other repair stages for this 30-second cycle.
    if (error instanceof QueueDrainOnlyError) {
      // Admission is an intentional deferral. Keep the obligation pending so
      // the next pass can dispatch it after the operator/automatic gate opens;
      // do not turn a controlled drain-only response into a false scheduler
      // failure and restart loop.
      logInfo('Scheduler stage deferred by queue admission gate', {
        stage,
        queue: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
      });
      return null;
    }
    logError('Scheduler stage failed; continuing independent recovery paths', error, { stage });
    if (state) state.failed = true;
    return null;
  }
}

async function runPass(): Promise<void> {
  if (inFlight) return inFlight.then(() => undefined);
  const pass = (async () => {
    const stageState = { failed: false };
    const now = new Date();
    const season = await seasonRepository.findCurrent();
    const halfMinute = Math.floor(now.getTime() / SCHEDULER_INTERVAL_MS);
    const minute = Math.floor(now.getTime() / 60_000);
    if (getConfig().QUEUE_LANES_V2_ENABLED) {
      await runIndependentSchedulerStage(
        'publication-reconcile-enqueue',
        () =>
          enqueueDataGovernanceJob(season, DATA_GOVERNANCE_JOBS.PUBLICATION_RECONCILE, {
            jobId: `governance-publication-reconcile-${season.seasonCode}-${halfMinute}`,
          }),
        stageState,
      );
      await runIndependentSchedulerStage(
        'data-publication-outbox-enqueue',
        () =>
          enqueueMaintenanceJob(season, MAINTENANCE_JOBS.DATA_PUBLICATION_OUTBOX, 'reconcile', {
            jobId: `governance-publication-outbox-${season.seasonCode}-${halfMinute}`,
          }),
        stageState,
      );
      await runIndependentSchedulerStage(
        'lifecycle-status-enqueue',
        () =>
          enqueueDataGovernanceJob(season, DATA_GOVERNANCE_JOBS.LIFECYCLE_STATUS, {
            jobId: `governance-lifecycle-${season.seasonCode}-${Math.floor(now.getTime() / 30_000)}`,
          }),
        stageState,
      );
      if (now.getTime() % 60_000 < SCHEDULER_INTERVAL_MS) {
        await runIndependentSchedulerStage(
          'freshness-observer-enqueue',
          () =>
            enqueueDataGovernanceJob(season, DATA_GOVERNANCE_JOBS.FRESHNESS_OBSERVER, {
              jobId: `governance-freshness-${season.seasonCode}-${minute}`,
            }),
          stageState,
        );
        await runIndependentSchedulerStage(
          'governance-audit-enqueue',
          () =>
            enqueueDataGovernanceJob(season, DATA_GOVERNANCE_JOBS.GW_AUDIT, {
              jobId: `governance-audit-${season.seasonCode}-${minute}`,
            }),
          stageState,
        );
        await runIndependentSchedulerStage(
          'governance-case-recheck-enqueue',
          () =>
            enqueueDataGovernanceJob(season, DATA_GOVERNANCE_JOBS.CASE_RECHECK, {
              jobId: `governance-case-recheck-${season.seasonCode}-${minute}`,
            }),
          stageState,
        );
      }
    } else {
      await runIndependentSchedulerStage(
        'publication-reconcile-enqueue',
        () =>
          enqueueDataGovernanceJob(season, DATA_GOVERNANCE_JOBS.PUBLICATION_RECONCILE, {
            jobId: `governance-publication-reconcile-${season.seasonCode}-${halfMinute}`,
          }),
        stageState,
      );
      await runIndependentSchedulerStage(
        'data-publication-outbox-enqueue',
        () =>
          enqueueMaintenanceJob(season, MAINTENANCE_JOBS.DATA_PUBLICATION_OUTBOX, 'reconcile', {
            jobId: `governance-publication-outbox-${season.seasonCode}-${halfMinute}`,
          }),
        stageState,
      );
      await runIndependentSchedulerStage(
        'lifecycle-status-enqueue',
        () =>
          enqueueDataGovernanceJob(season, DATA_GOVERNANCE_JOBS.LIFECYCLE_STATUS, {
            jobId: `governance-lifecycle-${season.seasonCode}-${Math.floor(now.getTime() / 30_000)}`,
          }),
        stageState,
      );
    }
    const obligationResult = await runIndependentSchedulerStage(
      'obligation-registry',
      () => runSchedulerPass(now),
      stageState,
    );
    // A scheduler pass can return normally after isolating definition/claim/
    // enqueue failures.  Those failures are already persisted on the
    // obligation, but they must also suppress the progress heartbeat: a
    // healthy process with a non-progressing registry is not healthy for
    // scheduling purposes.
    if (obligationResult && obligationResult.failed > 0) {
      stageState.failed = true;
    }
    if (stageState.failed) {
      throw new Error('SCHEDULER_STAGE_FAILED: progress heartbeat withheld');
    }
  })()
    .then(() => {
      // The scheduler heartbeat is progress evidence, not merely process
      // liveness.  Touch it only after every independent stage completed.
      touchWorkerHeartbeat(schedulerHeartbeatPath);
    })
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
