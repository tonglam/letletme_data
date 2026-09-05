import { randomUUID } from 'node:crypto';
import type { Job, Queue, QueueEvents } from 'bullmq';

import { queueHealthWindowsInOps } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import {
  evaluateAutomaticAdmission,
  acquireQueueMonitorLease,
  calculateDrainEtaMs,
  classifyBacklog,
  inspectQueue,
  percentile,
  releaseQueueMonitorLease,
  writeQueueHealthSnapshot,
  QUEUE_HEALTH_RETENTION_LEASE_QUEUE,
  QUEUE_HEALTH_RETENTION_MAX_BATCHES,
  QUEUE_HEALTH_RETENTION_BATCH_SIZE,
  type QueueHealthSnapshot,
} from '../services/queue-governance.service';
import { pruneQueueHealthWindows } from '../services/data-governance.service';
import {
  readRuntimeHeartbeat,
  runtimeReleaseRevision,
  type RuntimeRole,
} from './runtime-heartbeat';
import { logDebug, logError, logInfo, logWarn } from './logger';
import { readFplAdmissionTelemetry } from './fpl-admission';
import { getConfig } from './config';
import { contractForSchedulerJob, dataContractRegistry } from '../domain/data-contracts';

type QueueCounts = Record<string, number>;

export interface QueueMonitorOptions {
  queue: Queue;
  queueEvents: QueueEvents;
  queueName?: string;
  pollIntervalMs?: number;
  dispatchBudgetMs?: number;
  consumerHeartbeatRole?: RuntimeRole;
}

const FALLBACK_DISPATCH_BUDGETS: Record<string, number> = {
  'official-h2h-live': 15_000,
  'live-data': 30_000,
  'live-picks': 30_000,
  'publication-outbox': 30_000,
  'data-sync': 60_000,
  // These queues are either legacy drain-only or delegated/internal lanes and
  // therefore do not have a public contract entry. Keep a bounded monitor
  // budget instead of silently disabling deadline classification for them.
  maintenance: 60 * 60_000,
  'content-media-transcript': 15 * 60_000,
  'content-x-scan': 15 * 60_000,
};

const REGISTRY_DISPATCH_BUDGETS = (() => {
  const budgets = new Map<string, number>();
  for (const contract of dataContractRegistry) {
    const previous = budgets.get(contract.queueLane);
    if (previous === undefined || contract.dispatchWithinMs < previous) {
      budgets.set(contract.queueLane, contract.dispatchWithinMs);
    }
  }
  return budgets;
})();

/**
 * Queue deadline classification uses the contract of the oldest runnable job
 * when that job is represented in the registry. This matters for mixed lanes:
 * a `data-repair` trends job has a one-hour budget while a player summary job
 * has a fifteen-minute budget. Fallbacks are limited to legacy or delegated
 * queues that intentionally have no public contract.
 */
export function resolveQueueDispatchBudgetMs(queueName: string): number | undefined {
  return REGISTRY_DISPATCH_BUDGETS.get(queueName) ?? FALLBACK_DISPATCH_BUDGETS[queueName];
}

export function resolveJobDispatchBudgetMs(
  queueName: string,
  job: Readonly<{ name: string; data?: unknown }>,
): number | null | undefined {
  const contractKey =
    job.data && typeof job.data === 'object' && 'contractKey' in job.data
      ? (job.data as { contractKey?: unknown }).contractKey
      : undefined;
  if (typeof contractKey === 'string') {
    const contract = dataContractRegistry.find((item) => item.contractKey === contractKey);
    if (contract) return contract.dispatchWithinMs;
  }
  const jobContract = contractForSchedulerJob(job.name);
  if (jobContract) return jobContract.dispatchWithinMs;
  const laneBudgets = new Set(
    dataContractRegistry
      .filter((contract) => contract.queueLane === queueName)
      .map((contract) => contract.dispatchWithinMs),
  );
  // A mixed lane without an identifiable contract is intentionally excluded
  // from deadline classification. Falling back to its minimum budget would
  // turn a valid long-budget job into a false red sample and could gate the
  // whole lane.
  if (laneBudgets.size > 1) return null;
  return resolveQueueDispatchBudgetMs(queueName);
}

type TimingJob = Pick<Job, 'timestamp' | 'processedOn' | 'finishedOn' | 'data'>;

/**
 * Completed Bull jobs are retained for operational history, but that
 * retention window is deliberately much longer than a queue-health sample.
 * Timing metrics must therefore use a bounded recent lookback; otherwise an
 * old replay can keep a queue's current p95 red for hours after the queue has
 * drained.  A null metric when no job completed recently is more truthful
 * than silently reporting stale latency.
 */
export const QUEUE_TIMING_LOOKBACK_MS = 15 * 60_000;

export type QueueTimingMetricsOptions = Readonly<{
  nowMs?: number;
  lookbackMs?: number;
}>;

export function resolveQueueTimingMetrics(
  jobs: readonly TimingJob[],
  options: QueueTimingMetricsOptions = {},
): Readonly<{
  waitP50Ms: number | null;
  waitP95Ms: number | null;
  executionP50Ms: number | null;
  executionP95Ms: number | null;
  providerWaitP95Ms: number | null;
  provider429Rate: number | null;
}> {
  const waits: number[] = [];
  const executions: number[] = [];
  const providerWaits: number[] = [];
  let providerSamples = 0;
  let provider429 = 0;
  const nowMs = options.nowMs ?? Date.now();
  const lookbackMs = Math.max(1, options.lookbackMs ?? QUEUE_TIMING_LOOKBACK_MS);
  const cutoffMs = nowMs - lookbackMs;
  for (const job of jobs) {
    const timestamp = Number(job.timestamp);
    const processedOn = Number(job.processedOn);
    const finishedOn = Number(job.finishedOn);
    // `getJobs(['completed'])` returns retained history, not just the current
    // telemetry interval.  A completed job is eligible only when its finish
    // time falls inside the explicit rolling lookback.
    if (!Number.isFinite(finishedOn) || finishedOn < cutoffMs || finishedOn > nowMs) {
      continue;
    }
    if (Number.isFinite(timestamp) && Number.isFinite(processedOn) && processedOn >= timestamp) {
      waits.push(Math.max(0, processedOn - timestamp));
    }
    if (Number.isFinite(processedOn) && Number.isFinite(finishedOn) && finishedOn >= processedOn) {
      executions.push(Math.max(0, finishedOn - processedOn));
    }
    const data =
      job.data && typeof job.data === 'object' ? (job.data as Record<string, unknown>) : null;
    const providerWait = data?.providerAdmissionWaitMs;
    if (typeof providerWait === 'number' && Number.isFinite(providerWait) && providerWait >= 0) {
      providerWaits.push(Math.floor(providerWait));
      providerSamples += 1;
    }
    const providerStatus = data?.providerStatus;
    if (providerStatus === 429 || providerStatus === '429' || data?.providerThrottled === true) {
      provider429 += 1;
      providerSamples = Math.max(providerSamples, 1);
    }
  }
  return {
    waitP50Ms: percentile(waits, 0.5),
    waitP95Ms: percentile(waits, 0.95),
    executionP50Ms: percentile(executions, 0.5),
    executionP95Ms: percentile(executions, 0.95),
    providerWaitP95Ms: percentile(providerWaits, 0.95),
    provider429Rate: providerSamples > 0 ? provider429 / providerSamples : null,
  };
}

function toError(reason?: string) {
  return reason ? new Error(reason) : undefined;
}

async function resolveJobName(queue: Queue, jobId?: string) {
  if (!jobId) return undefined;
  try {
    const job = await queue.getJob(jobId);
    return job?.name;
  } catch (error) {
    logError('Queue monitor failed to load job', error, { queue: queue.name, jobId });
    return undefined;
  }
}

function windowStart(
  now = Date.now(),
  intervalMs = getConfig().QUEUE_HEALTH_WINDOW_INTERVAL_MS,
): Date {
  return new Date(Math.floor(now / intervalMs) * intervalMs);
}

export const QUEUE_HEALTH_STABLE_PERSIST_INTERVAL_MS = 60 * 60_000;

/**
 * Persist changes that affect queue control or incident reconstruction, not
 * continuously changing observation timestamps and retained completion
 * counters. The complete current snapshot remains in Redis.
 */
export function queueHealthPersistenceFingerprint(snapshot: QueueHealthSnapshot): string {
  return JSON.stringify([
    snapshot.releaseSha,
    snapshot.backlogClass,
    snapshot.admissionMode,
    snapshot.waiting,
    snapshot.active,
    snapshot.delayed,
    snapshot.prioritized,
    snapshot.waitingChildren,
    snapshot.failed,
    snapshot.runnable,
    snapshot.arrivals,
    snapshot.completions,
    snapshot.failures,
    snapshot.stalled,
  ]);
}

export function shouldPersistQueueHealthWindow(input: {
  snapshot: QueueHealthSnapshot;
  lastFingerprint: string | null;
  lastPersistedAtMs: number;
  stablePersistIntervalMs?: number;
}): boolean {
  const observedAtMs = Date.parse(input.snapshot.observedAt);
  const nowMs = Number.isFinite(observedAtMs) ? observedAtMs : Date.now();
  return (
    input.lastFingerprint === null ||
    input.lastFingerprint !== queueHealthPersistenceFingerprint(input.snapshot) ||
    nowMs - input.lastPersistedAtMs >=
      (input.stablePersistIntervalMs ?? QUEUE_HEALTH_STABLE_PERSIST_INTERVAL_MS)
  );
}

async function persistWindow(snapshot: QueueHealthSnapshot, intervalMs: number): Promise<boolean> {
  try {
    const db = await getDb();
    const window = windowStart(Date.parse(snapshot.observedAt), intervalMs);
    await db
      .insert(queueHealthWindowsInOps)
      .values({
        windowStart: window,
        queueName: snapshot.queueName,
        waiting: snapshot.waiting,
        active: snapshot.active,
        delayed: snapshot.delayed,
        prioritized: snapshot.prioritized,
        waitingChildren: snapshot.waitingChildren,
        failed: snapshot.failed,
        completed: snapshot.completed,
        runnable: snapshot.runnable,
        oldestRunnableAgeMs: snapshot.oldestRunnableAgeMs,
        // The monitor already carries a bounded one-minute event accumulator
        // in the snapshot. Persist that evidence verbatim so an upsert from a
        // later poll cannot erase arrivals/completions observed earlier in the
        // same minute.
        arrivals: snapshot.arrivals,
        completions: snapshot.completions,
        failures: snapshot.failures,
        stalled: snapshot.stalled,
        waitP50Ms: snapshot.waitP50Ms,
        waitP95Ms: snapshot.waitP95Ms,
        executionP50Ms: snapshot.executionP50Ms,
        executionP95Ms: snapshot.executionP95Ms,
        providerWaitP95Ms: snapshot.providerWaitP95Ms,
        provider429Rate: snapshot.provider429Rate?.toFixed(5),
        netGrowth: snapshot.netGrowth,
        drainEtaMs: snapshot.drainEtaMs,
        backlogClass: snapshot.backlogClass,
        admissionMode: snapshot.admissionMode,
        consumerHeartbeatAt: snapshot.consumerHeartbeatAt
          ? new Date(snapshot.consumerHeartbeatAt)
          : null,
        releaseSha: snapshot.releaseSha,
        evidence: {
          source: 'queue-monitor',
          admission: {
            waitP95Ms: snapshot.admissionWaitP95Ms ?? null,
            deadlineExceeded: snapshot.admissionDeadlineExceeded ?? 0,
            storeUnavailable: snapshot.admissionStoreUnavailable ?? 0,
          },
        },
      })
      .onConflictDoUpdate({
        target: [queueHealthWindowsInOps.windowStart, queueHealthWindowsInOps.queueName],
        set: {
          waiting: snapshot.waiting,
          active: snapshot.active,
          delayed: snapshot.delayed,
          prioritized: snapshot.prioritized,
          waitingChildren: snapshot.waitingChildren,
          failed: snapshot.failed,
          completed: snapshot.completed,
          runnable: snapshot.runnable,
          oldestRunnableAgeMs: snapshot.oldestRunnableAgeMs,
          arrivals: snapshot.arrivals,
          completions: snapshot.completions,
          failures: snapshot.failures,
          stalled: snapshot.stalled,
          waitP50Ms: snapshot.waitP50Ms,
          waitP95Ms: snapshot.waitP95Ms,
          executionP50Ms: snapshot.executionP50Ms,
          executionP95Ms: snapshot.executionP95Ms,
          providerWaitP95Ms: snapshot.providerWaitP95Ms,
          provider429Rate: snapshot.provider429Rate?.toFixed(5) ?? null,
          evidence: {
            source: 'queue-monitor',
            admission: {
              waitP95Ms: snapshot.admissionWaitP95Ms ?? null,
              deadlineExceeded: snapshot.admissionDeadlineExceeded ?? 0,
              storeUnavailable: snapshot.admissionStoreUnavailable ?? 0,
            },
          },
          netGrowth: snapshot.netGrowth,
          drainEtaMs: snapshot.drainEtaMs,
          consumerHeartbeatAt: snapshot.consumerHeartbeatAt
            ? new Date(snapshot.consumerHeartbeatAt)
            : null,
          backlogClass: snapshot.backlogClass,
          admissionMode: snapshot.admissionMode,
          releaseSha: snapshot.releaseSha,
          updatedAt: window,
        },
      });
    return true;
  } catch (error) {
    // Queue telemetry is an observability side channel. A migration or a
    // transient PG outage must not stop consumers from draining work.
    logError('Queue health window persistence failed', error, { queue: snapshot.queueName });
    return false;
  }
}

export function startQueueMonitor(options: QueueMonitorOptions) {
  const { queue, queueEvents } = options;
  const queueName = options.queueName ?? queue.name;
  const pollIntervalMs = options.pollIntervalMs ?? getConfig().QUEUE_HEALTH_SNAPSHOT_INTERVAL_MS;
  const windowIntervalMs = getConfig().QUEUE_HEALTH_WINDOW_INTERVAL_MS;
  const dispatchBudgetMs = options.dispatchBudgetMs ?? resolveQueueDispatchBudgetMs(queueName);
  let pollInterval: NodeJS.Timeout | null = null;
  let lastCounts: QueueCounts | null = null;
  let lastSnapshot: QueueHealthSnapshot | undefined;
  let eventWindowStartMs = windowStart(Date.now(), windowIntervalMs).getTime();
  let windowArrivals = 0;
  let windowCompletions = 0;
  let windowFailures = 0;
  let windowStalled = 0;
  let failedEvents = 0;
  let stalledEvents = 0;
  let completedEvents = 0;
  let addedEvents = 0;
  let started = false;
  const leaseOwner = randomUUID();
  let lastRetentionAttemptAt = 0;
  let lastPersistedFingerprint: string | null = null;
  let lastPersistedAtMs = 0;

  const logCounts = async (context: string) => {
    try {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'prioritized',
        'waiting-children',
        'failed',
        'completed',
      );
      const heartbeat = options.consumerHeartbeatRole
        ? await readRuntimeHeartbeat(options.consumerHeartbeatRole).catch(() => null)
        : undefined;
      const timingJobs = await queue.getJobs(['completed'], 0, 99, false).catch(() => [] as Job[]);
      const timing = resolveQueueTimingMetrics(timingJobs, {
        nowMs: Date.now(),
        // Keep latency rolling over a bounded recent period instead of
        // allowing Bull's retained completed history to dominate p95.
        lookbackMs: QUEUE_TIMING_LOOKBACK_MS,
      });
      // Admission telemetry is written to both a global bucket and a
      // queue-attributed bucket. A monitor must read only its own bucket;
      // copying the global FPL sample into every queue creates false backlog
      // and provider-throttled signals on unrelated workers.
      const admissionTelemetry = await readFplAdmissionTelemetry(Date.now(), queueName).catch(
        () => null,
      );
      const snapshot = await inspectQueue(queue, {
        dispatchBudgetMs,
        dispatchBudgetForJob: (job) => resolveJobDispatchBudgetMs(queueName, job),
        releaseSha: heartbeat?.releaseSha ?? runtimeReleaseRevision(),
        ...timing,
        providerWaitP95Ms: timing.providerWaitP95Ms,
        provider429Rate: admissionTelemetry?.response429Rate ?? timing.provider429Rate,
        admissionWaitP95Ms: admissionTelemetry?.waitP95Ms ?? null,
        admissionDeadlineExceeded: admissionTelemetry?.deadlineExceeded ?? 0,
        admissionStoreUnavailable: admissionTelemetry?.storeUnavailable ?? 0,
        ...(options.consumerHeartbeatRole
          ? { consumerHeartbeatAt: heartbeat?.lastSeenAt ?? null }
          : {}),
      });
      const deltas = lastCounts
        ? {
            waitingDelta: (counts.waiting ?? 0) - (lastCounts.waiting ?? 0),
            activeDelta: (counts.active ?? 0) - (lastCounts.active ?? 0),
            delayedDelta: (counts.delayed ?? 0) - (lastCounts.delayed ?? 0),
            failedDelta: (counts.failed ?? 0) - (lastCounts.failed ?? 0),
          }
        : {};
      let withEvents: QueueHealthSnapshot = {
        ...snapshot,
        arrivals: 0,
        completions: 0,
        failures: 0,
        stalled: 0,
        netGrowth:
          snapshot.waiting +
          snapshot.active -
          (lastSnapshot?.waiting ?? 0) -
          (lastSnapshot?.active ?? 0),
        drainEtaMs: calculateDrainEtaMs(snapshot.runnable, windowArrivals, windowCompletions),
      };
      const observedMs = Date.parse(snapshot.observedAt);
      if (Number.isFinite(observedMs) && observedMs >= eventWindowStartMs + windowIntervalMs) {
        eventWindowStartMs = windowStart(observedMs, windowIntervalMs).getTime();
        windowArrivals = 0;
        windowCompletions = 0;
        windowFailures = 0;
        windowStalled = 0;
      }
      const sampleArrivals = lastSnapshot
        ? Math.max(
            0,
            snapshot.waiting + snapshot.active - lastSnapshot.waiting - lastSnapshot.active,
          )
        : 0;
      // QueueEvents sees jobs that arrive and finish between two polls, while
      // the count delta sees work that remains runnable. Prefer the event count
      // when available and retain the delta as a no-event fallback.
      windowArrivals += addedEvents > 0 ? addedEvents : sampleArrivals;
      windowCompletions += completedEvents;
      windowFailures += failedEvents;
      windowStalled += stalledEvents;
      withEvents = {
        ...withEvents,
        arrivals: windowArrivals,
        completions: windowCompletions,
        failures: windowFailures,
        stalled: windowStalled,
        drainEtaMs: calculateDrainEtaMs(snapshot.runnable, windowArrivals, windowCompletions),
        // inspectQueue cannot see the event accumulator (it is intentionally a
        // pure point-in-time read). Reclassify after folding the one-minute
        // arrivals/completions so BURST and POISON_STORM are not masked by a
        // healthy-looking instantaneous count.
        backlogClass: classifyBacklog({
          waiting: snapshot.waiting,
          active: snapshot.active,
          failed: snapshot.failed,
          stalled: windowStalled,
          oldestRunnableAgeMs: snapshot.oldestRunnableAgeMs,
          dispatchBudgetMs: snapshot.dispatchBudgetMs ?? dispatchBudgetMs,
          providerWaitP95Ms: snapshot.providerWaitP95Ms,
          provider429Rate: snapshot.provider429Rate,
          admissionWaitP95Ms: snapshot.admissionWaitP95Ms,
          admissionDeadlineExceeded: snapshot.admissionDeadlineExceeded,
          admissionStoreUnavailable: snapshot.admissionStoreUnavailable,
          arrivalsPerMinute: windowArrivals,
          completionsPerMinute: windowCompletions,
          failuresPerMinute: windowFailures,
          ...(options.consumerHeartbeatRole
            ? {
                consumerHeartbeatAgeMs: heartbeat?.lastSeenAt
                  ? Math.max(0, Date.now() - Date.parse(heartbeat.lastSeenAt))
                  : null,
              }
            : {}),
        }),
      };
      logDebug('Queue job counts', {
        queue: queueName,
        context,
        counts,
        ...deltas,
        backlogClass: withEvents.backlogClass,
      });
      await writeQueueHealthSnapshot(withEvents).catch((error) =>
        logError('Queue health snapshot write failed', error, { queue: queueName }),
      );
      if (withEvents.backlogClass !== 'HEALTHY') {
        logWarn('Queue backlog classified', {
          queue: queueName,
          backlogClass: withEvents.backlogClass,
          runnable: withEvents.runnable,
          oldestRunnableAgeMs: withEvents.oldestRunnableAgeMs,
          drainEtaMs: withEvents.drainEtaMs,
        });
      }
      const isLeader = await acquireQueueMonitorLease(queueName, leaseOwner).catch((error) => {
        logError('Queue monitor leader lease failed', error, { queue: queueName });
        return false;
      });
      if (isLeader) {
        await evaluateAutomaticAdmission(withEvents).catch((error) =>
          logError('Automatic queue admission evaluation failed', error, { queue: queueName }),
        );
        if (
          shouldPersistQueueHealthWindow({
            snapshot: withEvents,
            lastFingerprint: lastPersistedFingerprint,
            lastPersistedAtMs,
          })
        ) {
          const persisted = await persistWindow(withEvents, windowIntervalMs);
          if (persisted) {
            lastPersistedFingerprint = queueHealthPersistenceFingerprint(withEvents);
            lastPersistedAtMs = Date.parse(withEvents.observedAt);
          }
        }
        // Queue health is sampled frequently, so retain only a bounded
        // 35-day operational history. A global Redis lease ensures one
        // monitor performs the bounded cleanup per hour during rollouts.
        if (Date.now() - lastRetentionAttemptAt >= 60 * 60_000) {
          lastRetentionAttemptAt = Date.now();
          const retentionLeader = await acquireQueueMonitorLease(
            QUEUE_HEALTH_RETENTION_LEASE_QUEUE,
            leaseOwner,
            3_700,
          ).catch((error) => {
            logError('Queue health retention lease failed', error, { queue: queueName });
            return false;
          });
          if (retentionLeader) {
            await pruneQueueHealthWindows({
              batchSize: QUEUE_HEALTH_RETENTION_BATCH_SIZE,
              maxBatches: QUEUE_HEALTH_RETENTION_MAX_BATCHES,
            }).catch((error) =>
              logError('Queue health retention failed', error, { queue: queueName }),
            );
          }
        }
      }
      lastCounts = counts;
      lastSnapshot = withEvents;
      failedEvents = 0;
      stalledEvents = 0;
      completedEvents = 0;
      addedEvents = 0;
    } catch (error) {
      logError('Queue job count fetch failed', error, { queue: queueName });
    }
  };

  queueEvents.on('failed', ({ jobId, failedReason, prev }) => {
    failedEvents += 1;
    void resolveJobName(queue, jobId).then((jobName) => {
      logError('Queue event failed', toError(failedReason), {
        queue: queueName,
        jobId,
        jobName,
        previous: prev,
      });
    });
  });

  queueEvents.on('added', () => {
    addedEvents += 1;
  });

  queueEvents.on('completed', ({ jobId, prev }) => {
    completedEvents += 1;
    void resolveJobName(queue, jobId).then((jobName) => {
      logDebug('Queue event completed', { queue: queueName, jobId, jobName, previous: prev });
    });
  });

  queueEvents.on('stalled', ({ jobId }) => {
    stalledEvents += 1;
    void resolveJobName(queue, jobId).then((jobName) => {
      logError('Queue event stalled', undefined, { queue: queueName, jobId, jobName });
    });
  });

  queueEvents.on('error', (error) => logError('Queue events error', error, { queue: queueName }));

  queueEvents
    .waitUntilReady()
    .then(() => {
      started = true;
      logInfo('Queue events ready', { queue: queueName, pollIntervalMs });
      void logCounts('startup');
      pollInterval = setInterval(() => {
        void logCounts('interval');
      }, pollIntervalMs);
    })
    .catch((error) => logError('Queue events init failed', error, { queue: queueName }));

  return {
    stop() {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      started = false;
      void releaseQueueMonitorLease(queueName, leaseOwner);
    },
    get started() {
      return started;
    },
  };
}
