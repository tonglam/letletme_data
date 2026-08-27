import { randomUUID } from 'node:crypto';

import { getSourceMediaRuntimeConfig } from './content/media/source-media-config';
import { processSourceMediaGate } from './content/media/source-media-processor';
import {
  claimSourceMediaGates,
  releaseSourceMediaGateLease,
  releaseSourceMediaGateLeases,
  renewSourceMediaGateLease,
  type ClaimedSourceMediaGate,
} from './content/media/source-media-repository';
import { createSourceMediaStorage } from './content/media/source-media-storage';
import type { SourceMediaProbeMode } from './content/media/source-media-storage';
import { runSourceMediaRetention } from './content/media/source-media-retention';
import { databaseSingleton } from './db/singleton';
import { redisSingleton } from './cache/singleton';
import { queueRedisSingleton } from './queues/redis';
import { getConfig } from './utils/config';
import { logError, logInfo, logWarn } from './utils/logger';
import { startRuntimeHeartbeat } from './utils/runtime-heartbeat';
import { startWorkerHeartbeat } from './utils/worker-heartbeat';
import { createShutdownController, installShutdownSignals } from './utils/shutdown-controller';

const CLAIM_INTERVAL_MS = 2_000;
const GATE_LEASE_MS = 5 * 60_000;
const LEASE_RENEW_INTERVAL_MS = 60_000;
const GATE_EXECUTION_TIMEOUT_MS = 4 * 60_000;
const RETENTION_POLL_INTERVAL_MS = 60 * 60_000;

const cliArgs = process.argv.slice(2);
const provisionAndProbe = cliArgs.includes('--provision-and-probe');
const probeModes = cliArgs.filter(
  (arg): arg is `--probe-${SourceMediaProbeMode}` =>
    arg === '--probe-tus' || arg === '--probe-standard' || arg === '--probe-tus-no-create',
);
if (probeModes.length > 1 || (probeModes.length > 0 && !provisionAndProbe)) {
  throw new Error('Source-media probe mode must be used exactly once with --provision-and-probe');
}
const probeMode: SourceMediaProbeMode =
  probeModes[0] === '--probe-standard'
    ? 'standard'
    : probeModes[0] === '--probe-tus-no-create'
      ? 'tus-no-create'
      : probeModes[0] === '--probe-tus'
        ? 'tus'
        : 'standard';
const flags = getSourceMediaRuntimeConfig({ requireCredentials: provisionAndProbe });
const storage =
  flags.supabaseUrl && flags.secretKey
    ? createSourceMediaStorage({
        supabaseUrl: flags.supabaseUrl,
        secretKey: flags.secretKey,
        bucket: flags.bucket,
      })
    : null;

if (provisionAndProbe) {
  if (!storage) throw new Error('Source-media Storage credentials are missing');
  await storage.provisionAndProbe(probeMode);
  logInfo('Source-media Storage provision and roundtrip probe passed', {
    bucket: flags.bucket,
    probeMode,
  });
  process.exit(0);
}

const workerId = `media-worker:${process.pid}:${randomUUID()}`;
let stopFileHeartbeat = (): void => undefined;
let stopRuntimeHeartbeat = (): void => undefined;

let shuttingDown = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let retentionTimer: ReturnType<typeof setInterval> | null = null;
let disabledKeepAliveTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let retentionInFlight: Promise<void> | null = null;
let retentionController: AbortController | null = null;
let lastRetentionDate: string | null = null;
const active = new Map<
  string,
  Readonly<{
    controller: AbortController;
    promise: Promise<void>;
  }>
>();

async function executeGate(
  gate: ClaimedSourceMediaGate,
  controller: AbortController,
): Promise<void> {
  if (!storage) throw new Error('Source-media Storage is unavailable');
  const timeout = setTimeout(
    () => controller.abort('source-media gate timeout'),
    GATE_EXECUTION_TIMEOUT_MS,
  );
  const renew = setInterval(() => {
    void renewSourceMediaGateLease({
      gateId: gate.gateId,
      workerId,
      leaseMs: GATE_LEASE_MS,
    })
      .then((renewed) => {
        if (!renewed) controller.abort('source-media gate lease lost');
      })
      .catch((error) => {
        logError('Source-media lease renewal failed', error, { gateId: gate.gateId });
        controller.abort('source-media gate lease renewal failed');
      });
  }, LEASE_RENEW_INTERVAL_MS);
  renew.unref?.();
  try {
    const result = await processSourceMediaGate(
      gate,
      { storage, bucket: flags.bucket },
      controller.signal,
    );
    logInfo('Source-media gate processed', {
      gateId: gate.gateId,
      receiptRevisionId: gate.receiptRevisionId,
      attempt: gate.attemptCount,
      state: result.status,
      retryAt: result.retryAt?.toISOString() ?? null,
    });
  } finally {
    clearTimeout(timeout);
    clearInterval(renew);
    if (controller.signal.aborted) {
      await releaseSourceMediaGateLease({ gateId: gate.gateId, workerId }).catch((error) => {
        logWarn('Source-media aborted gate lease release failed', {
          gateId: gate.gateId,
          error: error instanceof Error ? error.name : 'unknown',
        });
      });
    }
  }
}

function startGate(gate: ClaimedSourceMediaGate): void {
  const controller = new AbortController();
  const promise = executeGate(gate, controller)
    .catch((error) => {
      logError('Source-media gate execution failed', error, {
        gateId: gate.gateId,
        receiptRevisionId: gate.receiptRevisionId,
        attempt: gate.attemptCount,
      });
    })
    .finally(() => active.delete(gate.gateId));
  active.set(gate.gateId, { controller, promise });
}

async function poll(): Promise<void> {
  // Retention claims and releases its database connection before deleting
  // objects. Do not let a slow Storage retention pass block newly due gates.
  if (polling || shuttingDown || !flags.enabled) return;
  const availableSlots = flags.concurrency - active.size;
  if (availableSlots <= 0) return;
  polling = true;
  try {
    const gates = await claimSourceMediaGates({
      workerId,
      limit: availableSlots,
      leaseMs: GATE_LEASE_MS,
    });
    for (const gate of gates) startGate(gate);
  } catch (error) {
    logError('Source-media gate claim failed', error);
  } finally {
    polling = false;
  }
}

async function runRetentionIfDue(): Promise<void> {
  if (!flags.retentionEnabled || !storage || retentionInFlight || active.size > 0 || polling)
    return;
  const date = new Date().toISOString().slice(0, 10);
  if (lastRetentionDate === date) return;
  const controller = new AbortController();
  retentionController = controller;
  const run = runSourceMediaRetention({ workerId, storage, signal: controller.signal })
    .then(() => {
      lastRetentionDate = date;
    })
    .finally(() => {
      if (retentionController === controller) retentionController = null;
      retentionInFlight = null;
    });
  retentionInFlight = run;
  return run;
}

async function start(): Promise<void> {
  if (!flags.enabled) {
    stopFileHeartbeat = startWorkerHeartbeat({
      path: process.env.WORKER_HEARTBEAT_PATH ?? '/tmp/media-worker-heartbeat',
    });
    stopRuntimeHeartbeat = startRuntimeHeartbeat('mediaWorker');
    disabledKeepAliveTimer = setInterval(() => undefined, 60_000);
    logInfo('Source-media worker is disabled; heartbeat remains active');
    return;
  }
  if (!storage) throw new Error('Source-media Storage is unavailable');
  const appConfig = getConfig();
  if (appConfig.DATABASE_POOL_MAX !== 1) {
    throw new Error('media-worker requires DATABASE_POOL_MAX=1');
  }
  await databaseSingleton.connect();
  await storage.ensureBucket();
  stopFileHeartbeat = startWorkerHeartbeat({
    path: process.env.WORKER_HEARTBEAT_PATH ?? '/tmp/media-worker-heartbeat',
  });
  stopRuntimeHeartbeat = startRuntimeHeartbeat('mediaWorker');
  await poll();
  pollTimer = setInterval(() => void poll(), CLAIM_INTERVAL_MS);
  await runRetentionIfDue();
  retentionTimer = setInterval(() => void runRetentionIfDue(), RETENTION_POLL_INTERVAL_MS);
  logInfo('Source-media worker ready', {
    workerId,
    concurrency: flags.concurrency,
    bucket: flags.bucket,
    retentionEnabled: flags.retentionEnabled,
  });
}

const shutdownController = createShutdownController({
  stopIntake: () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (pollTimer) clearInterval(pollTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    if (disabledKeepAliveTimer) clearInterval(disabledKeepAliveTimer);
    for (const running of active.values()) running.controller.abort('media-worker shutdown');
    retentionController?.abort('media-worker shutdown');
    stopFileHeartbeat();
    stopRuntimeHeartbeat();
  },
  waitForInFlight: async () => {
    const results = await Promise.allSettled([
      ...[...active.values()].map((running) => running.promise),
      retentionInFlight,
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} media task(s) failed to drain`);
    }
  },
  closeResources: async () => {
    if (flags.enabled) {
      const released = await releaseSourceMediaGateLeases({ workerId }).catch((error) => {
        logWarn('Source-media graceful lease release failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return 0;
      });
      logInfo('Source-media graceful leases released', { released });
    }
    await Promise.all([
      databaseSingleton.disconnect(),
      redisSingleton.disconnect(),
      queueRedisSingleton.disconnect(),
    ]);
  },
});

installShutdownSignals(shutdownController);
process.on('uncaughtException', (error) =>
  shutdownController.fatal(error, 'Source-media worker uncaught exception'),
);
process.on('unhandledRejection', (error) =>
  shutdownController.fatal(error, 'Source-media worker unhandled rejection'),
);

void start().catch((error) => {
  logError('Source-media worker startup failed', error);
  void shutdownController.request('STARTUP_FAILED', 1);
});
