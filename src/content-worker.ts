import {
  loadBriefingManifest,
  type BriefingManifestBundle,
} from './content/acquisition/acquisition-manifest';
import {
  dispatchAcquisitionJobOutbox,
  type AcquisitionQueueName,
} from './content/acquisition/job-outbox';
import { reconcileBriefingSourceRegistry } from './content/acquisition/manifest-reconciler';
import { scheduleFormalAcquisition } from './content/acquisition/formal-scheduler';
import { planTriggeredContentWork } from './content/acquisition/triggered-work-planner';
import { compileXBudgetPolicy, type XBudgetPolicy } from './content/acquisition/x-budget';
import { assertContentRuntimeFlags, getContentRuntimeFlags } from './content/config';
import { dispatchPublicationOutbox } from './content/publication/revalidation';
import {
  closeContentHttpAcquisitionQueue,
  contentHttpAcquisitionQueueName,
  createFormalHttpWorkerRuntime,
  enqueueFormalHttpRun,
  getContentHttpAcquisitionQueue,
} from './content/workers/content-http-acquisition.queue';
import {
  closeContentXQueue,
  contentXScanQueueName,
  createConfiguredHostGrokRunner,
  createFormalXWorkerRuntime,
  enqueueFormalXRun,
  getContentXScanQueue,
} from './content/workers/content-x.queue';
import {
  closeContentMediaTranscriptQueue,
  contentMediaTranscriptQueueName,
  createFormalMediaWorkerRuntime,
  enqueueFormalMediaRun,
  getContentMediaTranscriptQueue,
} from './content/workers/content-media-transcript.queue';
import { databaseSingleton } from './db/singleton';
import { redisSingleton } from './cache/singleton';
import { queueRedisSingleton } from './queues/redis';
import { getConfig } from './utils/config';
import { logError, logInfo } from './utils/logger';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { startRuntimeHeartbeat, type QueueMonitorRuntimeState } from './utils/runtime-heartbeat';
import { startQueueMonitor } from './utils/queue-monitor';
import { createShutdownController, installShutdownSignals } from './utils/shutdown-controller';
import { drainWorkers } from './workers/worker-runtime';

const FORMAL_SCHEDULER_INTERVAL_MS = 30_000;
const ACQUISITION_JOB_OUTBOX_INTERVAL_MS = 5_000;
const PUBLICATION_OUTBOX_DISPATCH_INTERVAL_MS = 30_000;

getConfig();
const flags = getContentRuntimeFlags();
assertContentRuntimeFlags(flags);

const queueMonitorStates: Record<string, QueueMonitorRuntimeState> = {
  [contentXScanQueueName]:
    flags.pipelineEnabled && flags.xScanEnabled && flags.realGrokEnabled ? 'STARTING' : 'DISABLED',
  [contentHttpAcquisitionQueueName]:
    flags.pipelineEnabled && flags.httpAcquisitionEnabled ? 'STARTING' : 'DISABLED',
  [contentMediaTranscriptQueueName]:
    flags.pipelineEnabled && flags.podcastTranscriptEnabled ? 'STARTING' : 'DISABLED',
};

const stopHeartbeat = startWorkerHeartbeat({
  path: process.env.WORKER_HEARTBEAT_PATH ?? '/tmp/content-worker-heartbeat',
});
const stopRuntimeHeartbeat = startRuntimeHeartbeat('contentWorker', 30_000, () => ({
  queueMonitors: queueMonitorStates,
}));

let manifestBundle: BriefingManifestBundle | null = null;
let xBudgetPolicy: XBudgetPolicy | null = null;
let formalScheduler: ReturnType<typeof setInterval> | null = null;
let acquisitionJobOutboxDispatcher: ReturnType<typeof setInterval> | null = null;
let publicationOutboxDispatcher: ReturnType<typeof setInterval> | null = null;
let formalHttpRuntime: ReturnType<typeof createFormalHttpWorkerRuntime> | null = null;
let formalXRuntime: ReturnType<typeof createFormalXWorkerRuntime> | null = null;
let formalMediaRuntime: ReturnType<typeof createFormalMediaWorkerRuntime> | null = null;
const queueMonitors: Array<{ stop: () => void }> = [];
let formalScheduleInFlight: Promise<void> | null = null;
let formalXInitializationInFlight: Promise<void> | null = null;
let acquisitionJobOutboxDispatchInFlight: Promise<void> | null = null;
let publicationOutboxDispatchInFlight: Promise<void> | null = null;
let shuttingDown = false;

function runtimeGitRevision(): string {
  return (
    process.env.CONTENT_MANIFEST_GIT_REVISION?.trim() ||
    process.env.GIT_SHA?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    'unknown'
  );
}

function enabledAcquisitionQueues(): readonly AcquisitionQueueName[] {
  const queues: AcquisitionQueueName[] = [];
  if (formalXRuntime) queues.push('content-x-scan');
  if (flags.httpAcquisitionEnabled) queues.push('content-http-acquisition');
  if (formalMediaRuntime) queues.push('content-media-transcript');
  return queues;
}

async function dispatchPendingPublicationOutbox(): Promise<void> {
  if (shuttingDown) return;
  if (publicationOutboxDispatchInFlight) return publicationOutboxDispatchInFlight;

  const dispatch = dispatchPublicationOutbox()
    .then((delivered) => {
      if (delivered > 0) logInfo('Publication outbox rows delivered', { delivered });
    })
    .catch((error) => {
      logError('Publication outbox dispatch pass failed; rows remain pending', error);
    })
    .finally(() => {
      publicationOutboxDispatchInFlight = null;
    });
  publicationOutboxDispatchInFlight = dispatch;
  return dispatch;
}

async function dispatchPendingAcquisitionJobOutbox(): Promise<void> {
  if (shuttingDown) return;
  if (acquisitionJobOutboxDispatchInFlight) return acquisitionJobOutboxDispatchInFlight;
  const queueNames = enabledAcquisitionQueues();
  if (queueNames.length === 0) return;

  const dispatch = dispatchAcquisitionJobOutbox({
    enabledQueueNames: queueNames,
    hermesRunLeaseMs: flags.hermesTranscriptTimeoutMs + 5 * 60_000,
    enqueue: async (job) => {
      if (job.queueName === 'content-http-acquisition') {
        await enqueueFormalHttpRun(job);
        return;
      }
      if (job.queueName === 'content-x-scan' && formalXRuntime) {
        await enqueueFormalXRun(job);
        return;
      }
      if (job.queueName === 'content-media-transcript' && formalMediaRuntime) {
        await enqueueFormalMediaRun(job);
        return;
      }
      throw new Error(`Acquisition queue is not enabled in this runtime: ${job.queueName}`);
    },
  })
    .then((result) => {
      if (result.claimed > 0) logInfo('Acquisition job outbox dispatch completed', result);
    })
    .catch((error) => {
      logError('Acquisition job outbox dispatch failed; rows remain pending', error);
    })
    .finally(() => {
      acquisitionJobOutboxDispatchInFlight = null;
    });
  acquisitionJobOutboxDispatchInFlight = dispatch;
  return dispatch;
}

async function ensureFormalXRuntime(): Promise<void> {
  if (
    shuttingDown ||
    !flags.pipelineEnabled ||
    !flags.xScanEnabled ||
    !flags.realGrokEnabled ||
    !manifestBundle ||
    formalXRuntime
  ) {
    return;
  }
  if (formalXInitializationInFlight) return formalXInitializationInFlight;

  const initialization = (async () => {
    try {
      const executor = createConfiguredHostGrokRunner();
      formalXRuntime = createFormalXWorkerRuntime(executor, xBudgetPolicy ?? undefined);
      queueMonitorStates[contentXScanQueueName] = 'ENABLED';
      queueMonitors.push(
        startQueueMonitor({
          queue: getContentXScanQueue(),
          queueEvents: formalXRuntime.queueEvents,
          queueName: 'content-x-scan',
          consumerHeartbeatRole: 'contentWorker',
        }),
      );
      logInfo(
        'Host Grok runner client initialized; X acquisition will validate the host runner per run',
      );
      await dispatchPendingAcquisitionJobOutbox();
    } catch (error) {
      logError('Host Grok runner client initialization failed; X acquisition will retry', error);
    }
  })();
  formalXInitializationInFlight = initialization;
  try {
    await initialization;
  } finally {
    if (formalXInitializationInFlight === initialization) formalXInitializationInFlight = null;
  }
}

async function schedulePendingFormalAcquisition(): Promise<void> {
  if (shuttingDown) return;
  if (formalScheduleInFlight) return formalScheduleInFlight;
  if (!manifestBundle) return;

  const schedule = (async () => {
    await ensureFormalXRuntime();
    const result = await scheduleFormalAcquisition({
      fullRolloutEligible: manifestBundle.coverage.fullRolloutEligible,
      flags: formalXRuntime ? flags : { ...flags, xScanEnabled: false, realGrokEnabled: false },
      xBudgetPolicy: xBudgetPolicy ?? undefined,
      enqueueHttp: enqueueFormalHttpRun,
      enqueueX: enqueueFormalXRun,
    });
    if (result.claimed > 0 || result.skippedCoverageGate) {
      logInfo('Formal acquisition scheduler pass completed', result);
    }
    if (result.skippedCoverageGate && !flags.acquisitionShadowMode) return;
    const triggered = await planTriggeredContentWork({ flags });
    if (triggered.planned > 0 || triggered.reclaimed > 0 || triggered.providerPollRecovered > 0) {
      logInfo('Triggered acquisition planner pass completed', triggered);
    }
  })()
    .catch((error) => {
      logError('Formal acquisition scheduler pass failed', error);
    })
    .finally(() => {
      formalScheduleInFlight = null;
    });
  formalScheduleInFlight = schedule;
  return schedule;
}

async function startFormalAcquisition(): Promise<void> {
  if (shuttingDown || !flags.pipelineEnabled) return;
  try {
    const bundle = await loadBriefingManifest();
    const reconciliation = await reconcileBriefingSourceRegistry({
      bundle,
      gitRevision: runtimeGitRevision(),
      includeXBackstop: flags.xBackstopEnabled,
    });
    manifestBundle = bundle;
    if (flags.xScanEnabled && flags.realGrokEnabled) {
      xBudgetPolicy = compileXBudgetPolicy({
        coverage: bundle.coverage,
        globalRolling24hLimit: flags.dailyXCallLimit,
        final90Rolling90mLimit: flags.final90XCallLimit,
        identityRolling24hLimit: flags.identityXCallLimit,
        laneCapMultiplier: flags.xLaneCapMultiplier,
        // Shadow is used for controlled development/backfill runs. Do not
        // let the recurring production lane forecast block those runs; the
        // global and FINAL90 provider guards remain active.
        enforceLaneCaps: !flags.acquisitionShadowMode,
      });
    }
    logInfo('Briefing source manifest reconciled', {
      manifestHash: bundle.manifestHash,
      fullRolloutEligible: bundle.coverage.fullRolloutEligible,
      status: reconciliation.status,
      xLaneCapsEnforced: xBudgetPolicy?.enforceLaneCaps ?? null,
      xLaneCapMultiplier: xBudgetPolicy?.laneCapMultiplier ?? null,
      xBackstopEnabled: flags.xBackstopEnabled,
    });
  } catch (error) {
    // Acquisition fails closed, but publication delivery remains independent.
    logError('Briefing source manifest invalid; acquisition scheduler remains stopped', error);
    return;
  }

  if (shuttingDown) return;
  if (flags.httpAcquisitionEnabled) {
    formalHttpRuntime = createFormalHttpWorkerRuntime();
    queueMonitorStates[contentHttpAcquisitionQueueName] = 'ENABLED';
    queueMonitors.push(
      startQueueMonitor({
        queue: getContentHttpAcquisitionQueue(),
        queueEvents: formalHttpRuntime.queueEvents,
        queueName: 'content-http-acquisition',
        consumerHeartbeatRole: 'contentWorker',
      }),
    );
  }
  if (flags.podcastTranscriptEnabled) {
    formalMediaRuntime = createFormalMediaWorkerRuntime();
    queueMonitorStates[contentMediaTranscriptQueueName] = 'ENABLED';
    queueMonitors.push(
      startQueueMonitor({
        queue: getContentMediaTranscriptQueue(),
        queueEvents: formalMediaRuntime.queueEvents,
        queueName: 'content-media-transcript',
        consumerHeartbeatRole: 'contentWorker',
      }),
    );
  }
  await dispatchPendingAcquisitionJobOutbox();
  await schedulePendingFormalAcquisition();
  acquisitionJobOutboxDispatcher = setInterval(() => {
    void dispatchPendingAcquisitionJobOutbox();
  }, ACQUISITION_JOB_OUTBOX_INTERVAL_MS);
  formalScheduler = setInterval(() => {
    void schedulePendingFormalAcquisition();
  }, FORMAL_SCHEDULER_INTERVAL_MS);
}

// Publication revalidation is intentionally independent of source registry,
// Grok, feed parsing, and acquisition feature flags.
void dispatchPendingPublicationOutbox();
publicationOutboxDispatcher = setInterval(() => {
  void dispatchPendingPublicationOutbox();
}, PUBLICATION_OUTBOX_DISPATCH_INTERVAL_MS);

void startFormalAcquisition().catch((error) => {
  logError('Formal acquisition startup failed; publication delivery remains active', error);
});

const shutdownController = createShutdownController({
  stopIntake: () => {
    shuttingDown = true;
    queueMonitors.forEach((monitor) => monitor.stop());
    if (formalScheduler) clearInterval(formalScheduler);
    if (acquisitionJobOutboxDispatcher) clearInterval(acquisitionJobOutboxDispatcher);
    if (publicationOutboxDispatcher) clearInterval(publicationOutboxDispatcher);
    stopHeartbeat();
    stopRuntimeHeartbeat();
  },
  waitForInFlight: async () => {
    const inFlight = await Promise.allSettled([
      formalScheduleInFlight,
      formalXInitializationInFlight,
      acquisitionJobOutboxDispatchInFlight,
      publicationOutboxDispatchInFlight,
    ]);
    const failures = inFlight
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    await drainWorkers(
      [formalHttpRuntime, formalXRuntime, formalMediaRuntime]
        .filter((runtime): runtime is NonNullable<typeof runtime> => runtime != null)
        .map((runtime) => runtime.worker),
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} content task(s) failed to drain`);
    }
  },
  closeMonitors: () =>
    Promise.all([
      formalHttpRuntime?.queueEvents.close(),
      formalXRuntime?.queueEvents.close(),
      formalMediaRuntime?.queueEvents.close(),
    ]).then(() => undefined),
  closeProducerQueues: () =>
    Promise.all([
      closeContentHttpAcquisitionQueue(),
      closeContentXQueue(),
      closeContentMediaTranscriptQueue(),
    ]).then(() => undefined),
  closeDatabase: () => databaseSingleton.disconnect(),
  closeCacheRedis: () => redisSingleton.disconnect(),
  closeQueueRedis: () => queueRedisSingleton.disconnect(),
});

installShutdownSignals(shutdownController);
process.on('uncaughtException', (error) =>
  shutdownController.fatal(error, 'Content worker uncaught exception'),
);
process.on('unhandledRejection', (error) =>
  shutdownController.fatal(error, 'Content worker unhandled rejection'),
);

logInfo('Content worker process ready', {
  pipelineEnabled: flags.pipelineEnabled,
  acquisitionShadowMode: flags.acquisitionShadowMode,
  httpAcquisitionEnabled: flags.httpAcquisitionEnabled,
  xScanEnabled: flags.xScanEnabled,
  realGrokEnabled: flags.realGrokEnabled,
  podcastTranscriptEnabled: flags.podcastTranscriptEnabled,
  httpConcurrency: flags.httpConcurrency,
});
