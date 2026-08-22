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
  createFormalHttpWorkerRuntime,
  enqueueFormalHttpRun,
} from './content/workers/content-http-acquisition.queue';
import {
  closeContentXQueue,
  createConfiguredHostGrokRunner,
  createFormalXWorkerRuntime,
  enqueueFormalXRun,
} from './content/workers/content-x.queue';
import {
  closeContentMediaTranscriptQueue,
  createFormalMediaWorkerRuntime,
  enqueueFormalMediaRun,
} from './content/workers/content-media-transcript.queue';
import { databaseSingleton } from './db/singleton';
import { logError, logInfo } from './utils/logger';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { startRuntimeHeartbeat } from './utils/runtime-heartbeat';

const FORMAL_SCHEDULER_INTERVAL_MS = 30_000;
const ACQUISITION_JOB_OUTBOX_INTERVAL_MS = 5_000;
const PUBLICATION_OUTBOX_DISPATCH_INTERVAL_MS = 30_000;

const flags = getContentRuntimeFlags();
assertContentRuntimeFlags(flags);

const stopHeartbeat = startWorkerHeartbeat({
  path: process.env.WORKER_HEARTBEAT_PATH ?? '/tmp/content-worker-heartbeat',
});
const stopRuntimeHeartbeat = startRuntimeHeartbeat('contentWorker');

let manifestBundle: BriefingManifestBundle | null = null;
let xBudgetPolicy: XBudgetPolicy | null = null;
let formalScheduler: ReturnType<typeof setInterval> | null = null;
let acquisitionJobOutboxDispatcher: ReturnType<typeof setInterval> | null = null;
let publicationOutboxDispatcher: ReturnType<typeof setInterval> | null = null;
let formalHttpRuntime: ReturnType<typeof createFormalHttpWorkerRuntime> | null = null;
let formalXRuntime: ReturnType<typeof createFormalXWorkerRuntime> | null = null;
let formalMediaRuntime: ReturnType<typeof createFormalMediaWorkerRuntime> | null = null;
let formalScheduleInFlight: Promise<void> | null = null;
let formalXInitializationInFlight: Promise<void> | null = null;
let formalXRetryNotBefore = 0;
let formalXRetryDelayMs = FORMAL_SCHEDULER_INTERVAL_MS;
let acquisitionJobOutboxDispatchInFlight: Promise<void> | null = null;
let publicationOutboxDispatchInFlight: Promise<void> | null = null;

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
    !flags.pipelineEnabled ||
    !flags.xScanEnabled ||
    !flags.realGrokEnabled ||
    !manifestBundle ||
    formalXRuntime
  ) {
    return;
  }
  if (Date.now() < formalXRetryNotBefore) return;
  if (formalXInitializationInFlight) return formalXInitializationInFlight;

  const initialization = (async () => {
    try {
      const executor = createConfiguredHostGrokRunner();
      await executor.assertVersion();
      formalXRuntime = createFormalXWorkerRuntime(executor, xBudgetPolicy ?? undefined);
      formalXRetryNotBefore = 0;
      formalXRetryDelayMs = FORMAL_SCHEDULER_INTERVAL_MS;
      logInfo('Host Grok runner initialized; X acquisition enabled');
      await dispatchPendingAcquisitionJobOutbox();
    } catch (error) {
      formalXRetryNotBefore = Date.now() + formalXRetryDelayMs;
      formalXRetryDelayMs = Math.min(5 * 60_000, formalXRetryDelayMs * 2);
      logError('Grok Build version/provider check failed; X acquisition will retry', error, {
        retryAt: new Date(formalXRetryNotBefore).toISOString(),
      });
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
  if (!flags.pipelineEnabled) return;
  try {
    const bundle = await loadBriefingManifest();
    const reconciliation = await reconcileBriefingSourceRegistry({
      bundle,
      gitRevision: runtimeGitRevision(),
    });
    manifestBundle = bundle;
    if (flags.xScanEnabled && flags.realGrokEnabled) {
      xBudgetPolicy = compileXBudgetPolicy({
        coverage: bundle.coverage,
        globalRolling24hLimit: flags.dailyXCallLimit,
        final90Rolling90mLimit: flags.final90XCallLimit,
      });
    }
    logInfo('Briefing source manifest reconciled', {
      manifestHash: bundle.manifestHash,
      fullRolloutEligible: bundle.coverage.fullRolloutEligible,
      status: reconciliation.status,
    });
  } catch (error) {
    // Acquisition fails closed, but publication delivery remains independent.
    logError('Briefing source manifest invalid; acquisition scheduler remains stopped', error);
    return;
  }

  if (flags.httpAcquisitionEnabled) formalHttpRuntime = createFormalHttpWorkerRuntime();
  if (flags.podcastTranscriptEnabled) formalMediaRuntime = createFormalMediaWorkerRuntime();
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

async function shutdown(signal: string): Promise<void> {
  logInfo('Content worker shutting down', { signal });
  if (formalScheduler) clearInterval(formalScheduler);
  if (acquisitionJobOutboxDispatcher) clearInterval(acquisitionJobOutboxDispatcher);
  if (publicationOutboxDispatcher) clearInterval(publicationOutboxDispatcher);
  stopHeartbeat();
  stopRuntimeHeartbeat();
  await Promise.allSettled([
    formalScheduleInFlight,
    acquisitionJobOutboxDispatchInFlight,
    publicationOutboxDispatchInFlight,
  ]);
  await Promise.allSettled([
    formalHttpRuntime?.worker.close(),
    formalHttpRuntime?.queueEvents.close(),
    formalXRuntime?.worker.close(),
    formalXRuntime?.queueEvents.close(),
    formalMediaRuntime?.worker.close(),
    formalMediaRuntime?.queueEvents.close(),
    closeContentHttpAcquisitionQueue(),
    closeContentXQueue(),
    closeContentMediaTranscriptQueue(),
  ]);
  await databaseSingleton.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

logInfo('Content worker process ready', {
  pipelineEnabled: flags.pipelineEnabled,
  acquisitionShadowMode: flags.acquisitionShadowMode,
  httpAcquisitionEnabled: flags.httpAcquisitionEnabled,
  xScanEnabled: flags.xScanEnabled,
  realGrokEnabled: flags.realGrokEnabled,
  podcastTranscriptEnabled: flags.podcastTranscriptEnabled,
  httpConcurrency: flags.httpConcurrency,
});
