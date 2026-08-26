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
  type QueueHealthSnapshot,
} from '../services/queue-governance.service';
import {
  readRuntimeHeartbeat,
  runtimeReleaseRevision,
  type RuntimeRole,
} from './runtime-heartbeat';
import { logDebug, logError, logInfo, logWarn } from './logger';
import { readFplAdmissionTelemetry } from './fpl-admission';

type QueueCounts = Record<string, number>;

export interface QueueMonitorOptions {
  queue: Queue;
  queueEvents: QueueEvents;
  queueName?: string;
  pollIntervalMs?: number;
  dispatchBudgetMs?: number;
  consumerHeartbeatRole?: RuntimeRole;
}

const defaultPollIntervalMs = 15_000;
const WINDOW_MS = 60_000;

const DEFAULT_DISPATCH_BUDGETS: Record<string, number> = {
  'official-h2h-live': 15_000,
  'live-data': 30_000,
  'live-picks': 30_000,
  'publication-outbox': 30_000,
  'data-sync': 60_000,
};

type TimingJob = Pick<Job, 'timestamp' | 'processedOn' | 'finishedOn' | 'data'>;

export function resolveQueueTimingMetrics(jobs: readonly TimingJob[]): Readonly<{
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
  for (const job of jobs) {
    const timestamp = Number(job.timestamp);
    const processedOn = Number(job.processedOn);
    const finishedOn = Number(job.finishedOn);
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

function windowStart(now = Date.now()): Date {
  return new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
}

async function persistWindow(snapshot: QueueHealthSnapshot) {
  try {
    const db = await getDb();
    const window = windowStart(Date.parse(snapshot.observedAt));
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
        evidence: { source: 'queue-monitor' },
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
  } catch (error) {
    // Queue telemetry is an observability side channel. A migration or a
    // transient PG outage must not stop consumers from draining work.
    logError('Queue health window persistence failed', error, { queue: snapshot.queueName });
  }
}

export function startQueueMonitor(options: QueueMonitorOptions) {
  const { queue, queueEvents } = options;
  const queueName = options.queueName ?? queue.name;
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const dispatchBudgetMs = options.dispatchBudgetMs ?? DEFAULT_DISPATCH_BUDGETS[queueName];
  let pollInterval: NodeJS.Timeout | null = null;
  let lastCounts: QueueCounts | null = null;
  let lastSnapshot: QueueHealthSnapshot | undefined;
  let eventWindowStartMs = windowStart().getTime();
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
      const timing = resolveQueueTimingMetrics(timingJobs);
      const providerTelemetry = await readFplAdmissionTelemetry().catch(() => ({
        waitP95Ms: null,
        response429Rate: null,
        waitSamples: 0,
        responseSamples: 0,
      }));
      const snapshot = await inspectQueue(queue, {
        dispatchBudgetMs,
        releaseSha: heartbeat?.releaseSha ?? runtimeReleaseRevision(),
        ...timing,
        providerWaitP95Ms: providerTelemetry.waitP95Ms,
        provider429Rate: providerTelemetry.response429Rate,
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
      if (Number.isFinite(observedMs) && observedMs >= eventWindowStartMs + WINDOW_MS) {
        eventWindowStartMs = windowStart(observedMs).getTime();
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
          dispatchBudgetMs,
          providerWaitP95Ms: snapshot.providerWaitP95Ms,
          provider429Rate: snapshot.provider429Rate,
          arrivalsPerMinute: windowArrivals,
          completionsPerMinute: windowCompletions,
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
        await persistWindow(withEvents);
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
