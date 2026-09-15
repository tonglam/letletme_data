import { randomUUID } from 'node:crypto';
import type { Job, Queue, QueueEvents } from 'bullmq';
import { and, eq, gte, sql } from 'drizzle-orm';

import { queueHealthWindowsInOps } from '../db/schemas/index.schema';
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
import { getDatabaseHandleWithBudget } from './live-snapshot-db-budget';

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

export const QUEUE_MONITOR_EVENT_RETENTION_MS = 15 * 60_000;

export function queueMonitorEventRetentionMs(
  windowIntervalMs: number,
  pollIntervalMs: number,
): number {
  return Math.max(QUEUE_MONITOR_EVENT_RETENTION_MS, windowIntervalMs + pollIntervalMs);
}

/**
 * A no-event arrival delta is derived from the last successful Redis sample.
 * If that sample write fails, the next poll must be allowed to derive the same
 * delta again exactly once; otherwise a transient Redis error double-counts the
 * burst. Event-backed arrivals are handled separately by the accumulator.
 */
export function rollbackQueueSampleArrivals(
  windowArrivals: number,
  sampledArrivals: number,
  snapshotWritten: boolean,
): number {
  if (snapshotWritten || sampledArrivals <= 0) return windowArrivals;
  return Math.max(0, windowArrivals - sampledArrivals);
}

export type QueueEventCounters = {
  arrivals: number;
  completions: number;
  failures: number;
  stalled: number;
};

function emptyQueueEventCounters(): QueueEventCounters {
  return { arrivals: 0, completions: 0, failures: 0, stalled: 0 };
}

function mergeQueueEventCounters(target: QueueEventCounters, source: QueueEventCounters): void {
  target.arrivals += source.arrivals;
  target.completions += source.completions;
  target.failures += source.failures;
  target.stalled += source.stalled;
}

function addQueueEventCounters(
  left: QueueEventCounters | undefined,
  right: QueueEventCounters,
): QueueEventCounters {
  const result = left ? { ...left } : emptyQueueEventCounters();
  mergeQueueEventCounters(result, right);
  return result;
}

function totalQueueEventCounters(counters: QueueEventCounters): number {
  return counters.arrivals + counters.completions + counters.failures + counters.stalled;
}

/**
 * Receive-time event windows used by the monitor. Capturing a batch removes
 * only the events that the current poll will acknowledge; events received
 * while the poll is awaiting Redis or PostgreSQL remain in the next batch.
 */
export class QueueEventAccumulator {
  private readonly buckets = new Map<number, QueueEventCounters>();

  public constructor(
    private readonly windowIntervalMs: number,
    private readonly retentionMs = QUEUE_MONITOR_EVENT_RETENTION_MS,
  ) {}

  public record(kind: keyof QueueEventCounters, receivedAtMs = Date.now()): number {
    const bucketStart = windowStart(receivedAtMs, this.windowIntervalMs).getTime();
    const bucket = this.buckets.get(bucketStart) ?? emptyQueueEventCounters();
    bucket[kind] += 1;
    this.buckets.set(bucketStart, bucket);
    return this.prune(receivedAtMs);
  }

  public prune(nowMs = Date.now()): number {
    const cutoff = nowMs - this.retentionMs;
    let evicted = 0;
    for (const [startMs, counters] of this.buckets) {
      if (startMs < cutoff) {
        evicted += totalQueueEventCounters(counters);
        this.buckets.delete(startMs);
      }
    }
    return evicted;
  }

  public capture(nowMs?: number): Map<number, QueueEventCounters> {
    if (nowMs !== undefined) this.prune(nowMs);
    const captured = new Map<number, QueueEventCounters>();
    for (const [bucketStart, counters] of this.buckets) {
      captured.set(bucketStart, { ...counters });
      this.buckets.delete(bucketStart);
    }
    return captured;
  }

  public restore(captured: Map<number, QueueEventCounters>): void {
    for (const [bucketStart, counters] of captured) {
      const current = this.buckets.get(bucketStart) ?? emptyQueueEventCounters();
      mergeQueueEventCounters(current, counters);
      this.buckets.set(bucketStart, current);
    }
  }

  public pendingCount(): number {
    return [...this.buckets.values()].reduce(
      (total, counters) => total + totalQueueEventCounters(counters),
      0,
    );
  }
}

export function resolveQueueArrivalContribution(input: {
  previousSnapshot?: Pick<QueueHealthSnapshot, 'waiting' | 'active'>;
  snapshot: Pick<QueueHealthSnapshot, 'waiting' | 'active'>;
  eventArrivals: number;
}): Readonly<{ arrivals: number; sampledArrivals: number }> {
  const sampledArrivals = input.previousSnapshot
    ? Math.max(
        0,
        input.snapshot.waiting +
          input.snapshot.active -
          input.previousSnapshot.waiting -
          input.previousSnapshot.active,
      )
    : 0;
  if (input.eventArrivals > 0) {
    return { arrivals: input.eventArrivals, sampledArrivals: 0 };
  }
  return { arrivals: sampledArrivals, sampledArrivals };
}

type QueueHealthPersistenceSnapshot = QueueHealthSnapshot & {
  /** Historical retries carry event counters only; keep the original sample fields intact. */
  readonly eventCountersOnly?: boolean;
};

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
    snapshot.consumerPaused,
    snapshot.pausedCount,
    snapshot.pauseOwnerState,
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

function queueHealthWindowValues(snapshot: QueueHealthSnapshot, intervalMs: number) {
  const window = windowStart(Date.parse(snapshot.observedAt), intervalMs);
  return {
    windowStart: window,
    queueName: snapshot.queueName,
    waiting: snapshot.waiting,
    active: snapshot.active,
    delayed: snapshot.delayed,
    prioritized: snapshot.prioritized,
    waitingChildren: snapshot.waitingChildren,
    consumerPaused: snapshot.consumerPaused,
    pausedCount: snapshot.pausedCount,
    pauseOwnerState: snapshot.pauseOwnerState,
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
  };
}

function queueHealthWindowConflictSet() {
  return {
    waiting: sql`excluded.waiting`,
    active: sql`excluded.active`,
    delayed: sql`excluded.delayed`,
    prioritized: sql`excluded.prioritized`,
    waitingChildren: sql`excluded.waiting_children`,
    consumerPaused: sql`excluded.consumer_paused`,
    pausedCount: sql`excluded.paused_count`,
    pauseOwnerState: sql`excluded.pause_owner_state`,
    failed: sql`excluded.failed`,
    completed: sql`excluded.completed`,
    runnable: sql`excluded.runnable`,
    oldestRunnableAgeMs: sql`excluded.oldest_runnable_age_ms`,
    // Event counters are cumulative for a receive-time window. `greatest`
    // keeps a process restart or a delayed retry from replacing durable
    // evidence with the smaller in-memory count it has observed so far.
    arrivals: sql`greatest(${queueHealthWindowsInOps.arrivals}, excluded.arrivals)`,
    completions: sql`greatest(${queueHealthWindowsInOps.completions}, excluded.completions)`,
    failures: sql`greatest(${queueHealthWindowsInOps.failures}, excluded.failures)`,
    stalled: sql`greatest(${queueHealthWindowsInOps.stalled}, excluded.stalled)`,
    waitP50Ms: sql`excluded.wait_p50_ms`,
    waitP95Ms: sql`excluded.wait_p95_ms`,
    executionP50Ms: sql`excluded.execution_p50_ms`,
    executionP95Ms: sql`excluded.execution_p95_ms`,
    providerWaitP95Ms: sql`excluded.provider_wait_p95_ms`,
    provider429Rate: sql`excluded.provider_429_rate`,
    netGrowth: sql`excluded.net_growth`,
    drainEtaMs: sql`excluded.drain_eta_ms`,
    backlogClass: sql`excluded.backlog_class`,
    admissionMode: sql`excluded.admission_mode`,
    consumerHeartbeatAt: sql`excluded.consumer_heartbeat_at`,
    releaseSha: sql`excluded.release_sha`,
    evidence: sql`excluded.evidence`,
    updatedAt: sql`excluded.updated_at`,
  };
}

function queueHealthSnapshotForEventWindow(
  snapshot: QueueHealthSnapshot,
  windowStartMs: number,
  intervalMs: number,
  counters: QueueEventCounters,
): QueueHealthPersistenceSnapshot {
  const windowEndMs = windowStartMs + Math.max(1, intervalMs) - 1;
  const observedAtMs = Math.max(windowStartMs, Math.min(Date.now(), windowEndMs));
  return {
    ...snapshot,
    observedAt: new Date(observedAtMs).toISOString(),
    arrivals: counters.arrivals,
    completions: counters.completions,
    failures: counters.failures,
    stalled: counters.stalled,
    eventCountersOnly: true,
  };
}

function queueHealthEventWindowValues(snapshot: QueueHealthSnapshot, intervalMs: number) {
  const window = windowStart(Date.parse(snapshot.observedAt), intervalMs);
  return {
    windowStart: window,
    queueName: snapshot.queueName,
    arrivals: snapshot.arrivals,
    completions: snapshot.completions,
    failures: snapshot.failures,
    stalled: snapshot.stalled,
  };
}

type PersistedQueueEventTotals = {
  /** Drizzle returns Date values; the raw update path may return a string. */
  windowStart: Date | string;
  arrivals: number;
  completions: number;
  failures: number;
  stalled: number;
};

type PersistWindowsResult = {
  ok: boolean;
  eventTotals: Map<number, QueueEventCounters>;
};

function queueEventWindowStartMs(value: Date | string): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid persisted queue health window timestamp');
  return result;
}

function queueEventTotalsFromRow(row: PersistedQueueEventTotals): QueueEventCounters {
  return {
    arrivals: Number(row.arrivals ?? 0),
    completions: Number(row.completions ?? 0),
    failures: Number(row.failures ?? 0),
    stalled: Number(row.stalled ?? 0),
  };
}

async function loadQueueHealthEventTotals(
  queueName: string,
  nowMs: number,
  retentionMs: number,
): Promise<Map<number, QueueEventCounters>> {
  const db = await getDatabaseHandleWithBudget(5_000);
  const rows = await db
    .select({
      windowStart: queueHealthWindowsInOps.windowStart,
      arrivals: queueHealthWindowsInOps.arrivals,
      completions: queueHealthWindowsInOps.completions,
      failures: queueHealthWindowsInOps.failures,
      stalled: queueHealthWindowsInOps.stalled,
    })
    .from(queueHealthWindowsInOps)
    .where(
      and(
        eq(queueHealthWindowsInOps.queueName, queueName),
        gte(queueHealthWindowsInOps.windowStart, new Date(nowMs - retentionMs)),
      ),
    );
  return new Map(
    rows.map((row) => [
      queueEventWindowStartMs(row.windowStart),
      {
        arrivals: Number(row.arrivals ?? 0),
        completions: Number(row.completions ?? 0),
        failures: Number(row.failures ?? 0),
        stalled: Number(row.stalled ?? 0),
      },
    ]),
  );
}

async function persistWindows(
  snapshots: readonly QueueHealthPersistenceSnapshot[],
  intervalMs: number,
): Promise<PersistWindowsResult> {
  const eventTotals = new Map<number, QueueEventCounters>();
  if (snapshots.length === 0) return { ok: true, eventTotals };
  try {
    const db = await getDatabaseHandleWithBudget(5_000);
    const currentSnapshots = snapshots.filter((snapshot) => !snapshot.eventCountersOnly);
    const historicalSnapshots = snapshots.filter((snapshot) => snapshot.eventCountersOnly);
    if (currentSnapshots.length > 0) {
      const rows = await db
        .insert(queueHealthWindowsInOps)
        .values(currentSnapshots.map((snapshot) => queueHealthWindowValues(snapshot, intervalMs)))
        .onConflictDoUpdate({
          target: [queueHealthWindowsInOps.windowStart, queueHealthWindowsInOps.queueName],
          set: queueHealthWindowConflictSet(),
        })
        .returning({
          windowStart: queueHealthWindowsInOps.windowStart,
          arrivals: queueHealthWindowsInOps.arrivals,
          completions: queueHealthWindowsInOps.completions,
          failures: queueHealthWindowsInOps.failures,
          stalled: queueHealthWindowsInOps.stalled,
        });
      for (const row of rows as PersistedQueueEventTotals[]) {
        eventTotals.set(queueEventWindowStartMs(row.windowStart), queueEventTotalsFromRow(row));
      }
    }
    if (historicalSnapshots.length > 0) {
      // A delayed event-bucket retry must not create a point-in-time sample.
      // Update only a window that was observed by a normal poll; otherwise a
      // PostgreSQL outage covering the original window would be reconstructed
      // with schema defaults that falsely claim a healthy zero-backlog sample.
      // Keep the whole bounded batch in one statement so a backlog of event
      // windows cannot turn the monitor's five-second DB budget into one
      // round trip per bucket. The returned rows are the durable confirmation
      // set; a missing row remains an observation gap and is not acknowledged.
      const payload = JSON.stringify(
        historicalSnapshots.map((snapshot) => {
          const values = queueHealthEventWindowValues(snapshot, intervalMs);
          return {
            window_start: values.windowStart,
            queue_name: values.queueName,
            arrivals: values.arrivals,
            completions: values.completions,
            failures: values.failures,
            stalled: values.stalled,
          };
        }),
      );
      const rows = (await db.execute(sql`
        UPDATE ${queueHealthWindowsInOps} AS health
        SET arrivals = greatest(health.arrivals, incoming.arrivals),
            completions = greatest(health.completions, incoming.completions),
            failures = greatest(health.failures, incoming.failures),
            stalled = greatest(health.stalled, incoming.stalled),
            updated_at = clock_timestamp()
        FROM jsonb_to_recordset(${payload}::jsonb) AS incoming(
          window_start timestamptz,
          queue_name text,
          arrivals integer,
          completions integer,
          failures integer,
          stalled integer
        )
        WHERE health.window_start = incoming.window_start
          AND health.queue_name = incoming.queue_name
        RETURNING health.window_start AS "windowStart",
                  health.arrivals AS arrivals,
                  health.completions AS completions,
                  health.failures AS failures,
                  health.stalled AS stalled
      `)) as unknown as PersistedQueueEventTotals[];
      for (const row of rows) {
        eventTotals.set(queueEventWindowStartMs(row.windowStart), queueEventTotalsFromRow(row));
      }
    }
    return { ok: true, eventTotals };
  } catch (error) {
    // Queue telemetry is an observability side channel. A migration or a
    // transient PG outage must not stop consumers from draining work.
    logError('Queue health window persistence failed', error, {
      queue: snapshots[0]?.queueName,
      windows: snapshots.length,
    });
    return { ok: false, eventTotals };
  }
}

export function startQueueMonitor(options: QueueMonitorOptions) {
  const { queue, queueEvents } = options;
  const queueName = options.queueName ?? queue.name;
  const pollIntervalMs = options.pollIntervalMs ?? getConfig().QUEUE_HEALTH_SNAPSHOT_INTERVAL_MS;
  const windowIntervalMs = getConfig().QUEUE_HEALTH_WINDOW_INTERVAL_MS;
  // A configured health window can be wider than the default fifteen-minute
  // event retention. Keep an entire bucket plus one poll interval so events
  // received near the start of a wide window cannot expire before capture.
  const eventRetentionMs = queueMonitorEventRetentionMs(windowIntervalMs, pollIntervalMs);
  const dispatchBudgetMs = options.dispatchBudgetMs ?? resolveQueueDispatchBudgetMs(queueName);
  let pollInterval: NodeJS.Timeout | null = null;
  let lastCounts: QueueCounts | null = null;
  let lastSnapshot: QueueHealthSnapshot | undefined;
  let eventWindowStartMs = windowStart(Date.now(), windowIntervalMs).getTime();
  let windowArrivals = 0;
  let windowCompletions = 0;
  let windowFailures = 0;
  let windowStalled = 0;
  // QueueEvents can arrive while a poll is waiting on Redis or PostgreSQL.
  // Keep them in receive-time buckets so a slow poll cannot attribute an old
  // burst to the next window or lose events when persistence fails.
  const eventAccumulator = new QueueEventAccumulator(windowIntervalMs, eventRetentionMs);
  // Keep cumulative event totals for each retained window. The accumulator
  // only owns unconfirmed batches; this map supplies the absolute value for an
  // idempotent PostgreSQL upsert when a later poll confirms another batch.
  const acknowledgedEventTotals = new Map<number, QueueEventCounters>();
  let started = false;
  let stopped = false;
  let pollInFlight: Promise<void> | null = null;
  let eventBaselineLoaded = false;
  const leaseOwner = randomUUID();
  let lastRetentionAttemptAt = 0;
  let lastPersistedFingerprint: string | null = null;
  let lastPersistedAtMs = 0;

  const pruneAcknowledgedEventTotals = (nowMs: number): number => {
    const cutoff = nowMs - eventRetentionMs;
    let evicted = 0;
    for (const [bucketStart, counters] of acknowledgedEventTotals) {
      if (bucketStart < cutoff) {
        evicted += totalQueueEventCounters(counters);
        acknowledgedEventTotals.delete(bucketStart);
      }
    }
    return evicted;
  };

  const recordEvent = (kind: keyof QueueEventCounters, receivedAtMs = Date.now()): void => {
    if (stopped) return;
    const evictedAcknowledged = pruneAcknowledgedEventTotals(receivedAtMs);
    if (evictedAcknowledged > 0) {
      logDebug('Queue monitor acknowledged event totals expired', {
        queue: queueName,
        evicted: evictedAcknowledged,
        retentionMs: eventRetentionMs,
      });
    }
    const evicted = eventAccumulator.record(kind, receivedAtMs);
    if (evicted > 0) {
      logWarn('Queue monitor event observation window exceeded', {
        queue: queueName,
        evicted,
        retentionMs: eventRetentionMs,
      });
    }
  };

  const logCounts = async (context: string): Promise<void> => {
    if (stopped) return;
    const pollStartedAtMs = Date.now();
    pruneAcknowledgedEventTotals(pollStartedAtMs);
    const evictedBeforeCapture = eventAccumulator.prune(pollStartedAtMs);
    if (evictedBeforeCapture > 0) {
      logWarn('Queue monitor event observation window exceeded', {
        queue: queueName,
        evicted: evictedBeforeCapture,
        retentionMs: eventRetentionMs,
      });
    }
    if (!eventBaselineLoaded) {
      try {
        const persisted = await loadQueueHealthEventTotals(
          queueName,
          pollStartedAtMs,
          eventRetentionMs,
        );
        for (const [bucketStart, counters] of persisted) {
          acknowledgedEventTotals.set(bucketStart, counters);
        }
        const current = persisted.get(eventWindowStartMs);
        if (current) {
          windowArrivals = current.arrivals;
          windowCompletions = current.completions;
          windowFailures = current.failures;
          windowStalled = current.stalled;
        }
        eventBaselineLoaded = true;
        logDebug('Queue monitor event baseline loaded', {
          queue: queueName,
          windows: persisted.size,
          retentionMs: eventRetentionMs,
        });
      } catch (error) {
        // Do not acknowledge QueueEvents while the durable baseline is
        // unknown. Redis telemetry can still be sampled, but the event batch
        // must be retried after the database becomes readable.
        logError('Queue monitor event baseline load failed', error, {
          queue: queueName,
          retentionMs: eventRetentionMs,
        });
      }
    }
    const capturedEvents = eventAccumulator.capture();
    const capturedEventCount = [...capturedEvents.values()].reduce(
      (total, counters) => total + totalQueueEventCounters(counters),
      0,
    );
    // A captured event is acknowledged only after the durable window upsert
    // succeeds. Redis is the point-in-time serving snapshot, but it cannot
    // replace the PostgreSQL history used to reconstruct a burst or stall.
    let capturedForWindowForRetry = emptyQueueEventCounters();
    let sampledArrivalsForRetry = 0;
    let capturedEventsRestored = false;
    const confirmedCapturedWindows = new Set<number>();
    let snapshotWritten = false;
    let databasePersisted: boolean | null = null;
    logDebug('Queue monitor poll started', {
      queue: queueName,
      context,
      capturedEvents: [...capturedEvents.values()].reduce(
        (total, counters) => total + totalQueueEventCounters(counters),
        0,
      ),
    });
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
        const acknowledged = acknowledgedEventTotals.get(eventWindowStartMs);
        windowArrivals = acknowledged?.arrivals ?? 0;
        windowCompletions = acknowledged?.completions ?? 0;
        windowFailures = acknowledged?.failures ?? 0;
        windowStalled = acknowledged?.stalled ?? 0;
      }
      const capturedForWindow = emptyQueueEventCounters();
      const capturedEventTotals = new Map<number, QueueEventCounters>();
      for (const [bucketStart, counters] of capturedEvents) {
        if (bucketStart === eventWindowStartMs) {
          mergeQueueEventCounters(capturedForWindow, counters);
        }
        capturedEventTotals.set(
          bucketStart,
          addQueueEventCounters(acknowledgedEventTotals.get(bucketStart), counters),
        );
      }
      capturedForWindowForRetry = capturedForWindow;
      const capturedOutsideWindow = [...capturedEventTotals.entries()].filter(
        ([bucketStart]) => bucketStart !== eventWindowStartMs,
      );
      // QueueEvents sees jobs that arrive and finish between two polls, while
      // the count delta sees work that remains runnable. Prefer the event count
      // when available and retain the delta as a no-event fallback.
      const arrivalContribution = resolveQueueArrivalContribution({
        previousSnapshot: lastSnapshot,
        snapshot,
        eventArrivals: capturedForWindow.arrivals,
      });
      windowArrivals += arrivalContribution.arrivals;
      sampledArrivalsForRetry = arrivalContribution.sampledArrivals;
      windowCompletions += capturedForWindow.completions;
      windowFailures += capturedForWindow.failures;
      windowStalled += capturedForWindow.stalled;
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
      const outsideWindowSnapshots = capturedOutsideWindow.map(([bucketStart, counters]) =>
        queueHealthSnapshotForEventWindow(withEvents, bucketStart, windowIntervalMs, counters),
      );
      if (stopped) {
        eventAccumulator.restore(capturedEvents);
        capturedEventsRestored = true;
        return;
      }
      logDebug('Queue job counts', {
        queue: queueName,
        context,
        counts,
        ...deltas,
        backlogClass: withEvents.backlogClass,
      });
      try {
        await writeQueueHealthSnapshot(withEvents);
        snapshotWritten = true;
      } catch (error) {
        // PostgreSQL history must not claim a Redis serving snapshot that was
        // never written. Keep the captured QueueEvents batch for the next
        // poll and leave the previous point-in-time sample intact.
        logError('Queue health snapshot write failed', error, { queue: queueName, context });
        return;
      }
      logDebug('Queue monitor Redis snapshot written', {
        queue: queueName,
        context,
        eventWindowStartMs,
      });
      lastCounts = counts;
      lastSnapshot = withEvents;
      if (stopped) return;
      if (withEvents.backlogClass !== 'HEALTHY') {
        logWarn('Queue backlog classified', {
          queue: queueName,
          backlogClass: withEvents.backlogClass,
          runnable: withEvents.runnable,
          oldestRunnableAgeMs: withEvents.oldestRunnableAgeMs,
          drainEtaMs: withEvents.drainEtaMs,
        });
      }
      if (stopped) return;
      const isLeader = await acquireQueueMonitorLease(queueName, leaseOwner).catch((error) => {
        logError('Queue monitor leader lease failed', error, { queue: queueName });
        return false;
      });
      if (isLeader) {
        if (stopped) {
          await releaseQueueMonitorLease(queueName, leaseOwner);
          return;
        }
        await evaluateAutomaticAdmission(withEvents).catch((error) =>
          logError('Automatic queue admission evaluation failed', error, { queue: queueName }),
        );
        if (stopped) return;
        const persistCurrentWindow = shouldPersistQueueHealthWindow({
          snapshot: withEvents,
          lastFingerprint: lastPersistedFingerprint,
          lastPersistedAtMs,
        });
        const snapshotsToPersist = [
          ...(persistCurrentWindow ? [withEvents] : []),
          ...outsideWindowSnapshots,
        ];
        if (snapshotsToPersist.length > 0) {
          // A restart must first load the persisted event baseline. Without
          // it, greatest(existing, excluded) would treat a post-restart count
          // as a replacement and lose events from the same health window.
          const canPersistEvents = eventBaselineLoaded || capturedEventTotals.size === 0;
          const persisted = canPersistEvents
            ? await persistWindows(snapshotsToPersist, windowIntervalMs)
            : { ok: false, eventTotals: new Map<number, QueueEventCounters>() };
          databasePersisted = persisted.ok;
          logDebug('Queue monitor database window persistence finished', {
            queue: queueName,
            context,
            persisted: persisted.ok,
            baselineLoaded: eventBaselineLoaded,
            windows: snapshotsToPersist.length,
            eventWindowStartMs,
          });
          if (persisted.ok) {
            // Historical event-only writes are update-only. A requested
            // window with no returned row had no original point-in-time
            // sample; do not acknowledge it with the in-memory counters or
            // imply that a synthetic queue snapshot was persisted.
            const persistedWindowStarts = new Set(persisted.eventTotals.keys());
            if (persistCurrentWindow) {
              lastPersistedFingerprint = queueHealthPersistenceFingerprint(withEvents);
              lastPersistedAtMs = Date.parse(withEvents.observedAt);
            }
            for (const [bucketStart] of capturedEventTotals) {
              // A batched upsert may contain only an outside receive-time
              // window when the current snapshot is stable. Confirm each
              // captured bucket only when that exact window was included in
              // the durable write; the other buckets must be retried.
              if (!persistedWindowStarts.has(bucketStart)) continue;
              const actual = persisted.eventTotals.get(bucketStart);
              if (!actual) continue;
              acknowledgedEventTotals.set(bucketStart, actual);
              confirmedCapturedWindows.add(bucketStart);
            }
            const actualCurrent = persisted.eventTotals.get(eventWindowStartMs);
            if (actualCurrent) {
              // A concurrent monitor may have acknowledged more events than
              // this process knew about. Carry the returned durable total into
              // the next sample so a later delta cannot move backwards.
              windowArrivals = actualCurrent.arrivals;
              windowCompletions = actualCurrent.completions;
              windowFailures = actualCurrent.failures;
              windowStalled = actualCurrent.stalled;
              withEvents = {
                ...withEvents,
                arrivals: windowArrivals,
                completions: windowCompletions,
                failures: windowFailures,
                stalled: windowStalled,
                drainEtaMs: calculateDrainEtaMs(
                  snapshot.runnable,
                  windowArrivals,
                  windowCompletions,
                ),
              };
              lastSnapshot = withEvents;
            }
          }
        } else {
          // A stable snapshot needs no PostgreSQL write when there are no new
          // event buckets to confirm. The receive-time buckets above force a
          // write even when the current point-in-time status is unchanged.
          databasePersisted =
            capturedEventTotals.size === 0 && totalQueueEventCounters(capturedForWindow) === 0;
        }
        if (stopped) return;
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
            if (stopped) {
              await releaseQueueMonitorLease(QUEUE_HEALTH_RETENTION_LEASE_QUEUE, leaseOwner);
              return;
            }
            const retentionDb = await getDatabaseHandleWithBudget(5_000).catch((error) => {
              logError('Queue health retention database budget failed', error, {
                queue: queueName,
              });
              return null;
            });
            if (retentionDb) {
              await pruneQueueHealthWindows({
                batchSize: QUEUE_HEALTH_RETENTION_BATCH_SIZE,
                maxBatches: QUEUE_HEALTH_RETENTION_MAX_BATCHES,
                db: retentionDb,
              }).catch((error) =>
                logError('Queue health retention failed', error, { queue: queueName }),
              );
            }
          }
        }
      }
    } catch (error) {
      if (!snapshotWritten) eventAccumulator.restore(capturedEvents);
      capturedEventsRestored = !snapshotWritten;
      logError('Queue job count fetch failed', error, { queue: queueName });
    } finally {
      // A non-leader has no durable confirmation. Likewise, Redis success
      // followed by a failed PostgreSQL upsert must retry the exact captured
      // batch. Restore only unconfirmed buckets; events received while this
      // poll was in flight already remain in the accumulator and are never
      // removed here.
      const activeCapturedEventCount = totalQueueEventCounters(capturedForWindowForRetry);
      // `capturedForWindowForRetry` is selected after the point-in-time read,
      // so it already reflects a window boundary crossed while Redis was
      // being queried. Roll it back whenever that folded batch was not
      // durably confirmed; checking the poll's starting window would leave a
      // new-window batch inflated after a failed cross-boundary retry.
      // The point-in-time count delta is only a fallback observation. If the
      // Redis snapshot was not accepted, lastSnapshot remains unchanged and
      // the same delta will be sampled again on the next poll; undo this fold
      // so one transient write failure cannot double-count the burst.
      windowArrivals = rollbackQueueSampleArrivals(
        windowArrivals,
        sampledArrivalsForRetry,
        snapshotWritten,
      );
      const activeCapturedWindow = activeCapturedEventCount > 0;
      const activeWindowConfirmed =
        activeCapturedWindow && confirmedCapturedWindows.has(eventWindowStartMs);
      if (activeCapturedWindow && !activeWindowConfirmed) {
        // The batch was already folded into the in-memory window before the
        // Redis/DB outcome became known. Undo that fold before restoring the
        // events so a retry adds them exactly once instead of inflating the
        // cumulative upsert on every failed poll.
        windowArrivals = Math.max(0, windowArrivals - capturedForWindowForRetry.arrivals);
        windowCompletions = Math.max(0, windowCompletions - capturedForWindowForRetry.completions);
        windowFailures = Math.max(0, windowFailures - capturedForWindowForRetry.failures);
        windowStalled = Math.max(0, windowStalled - capturedForWindowForRetry.stalled);
      }
      if (!capturedEventsRestored && capturedEventCount > 0) {
        const unconfirmed = new Map<number, QueueEventCounters>();
        for (const [bucketStart, counters] of capturedEvents) {
          if (!confirmedCapturedWindows.has(bucketStart)) {
            unconfirmed.set(bucketStart, { ...counters });
          }
        }
        if (unconfirmed.size > 0) {
          eventAccumulator.restore(unconfirmed);
          capturedEventsRestored = true;
        }
      }
      logDebug('Queue monitor poll finished', {
        queue: queueName,
        context,
        durationMs: Math.max(0, Date.now() - pollStartedAtMs),
        snapshotWritten,
        databasePersisted,
        inFlightEvents: eventAccumulator.pendingCount(),
      });
    }
  };

  queueEvents.on('failed', ({ jobId, failedReason, prev }) => {
    if (stopped) return;
    recordEvent('failures');
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
    if (stopped) return;
    recordEvent('arrivals');
  });

  queueEvents.on('completed', ({ jobId, prev }) => {
    if (stopped) return;
    recordEvent('completions');
    void resolveJobName(queue, jobId).then((jobName) => {
      logDebug('Queue event completed', { queue: queueName, jobId, jobName, previous: prev });
    });
  });

  queueEvents.on('stalled', ({ jobId }) => {
    if (stopped) return;
    recordEvent('stalled');
    void resolveJobName(queue, jobId).then((jobName) => {
      logError('Queue event stalled', undefined, { queue: queueName, jobId, jobName });
    });
  });

  queueEvents.on('error', (error) => logError('Queue events error', error, { queue: queueName }));

  queueEvents
    .waitUntilReady()
    .then(() => {
      if (stopped) return;
      started = true;
      logInfo('Queue events ready', { queue: queueName, pollIntervalMs });
      const scheduleNextPoll = (): void => {
        if (!started) return;
        pollInterval = setTimeout(() => {
          pollInterval = null;
          if (!started || pollInFlight !== null) return;
          const poll = logCounts('interval');
          pollInFlight = poll;
          void poll.finally(() => {
            if (pollInFlight === poll) pollInFlight = null;
            scheduleNextPoll();
          });
        }, pollIntervalMs);
      };
      const startupPoll = logCounts('startup');
      pollInFlight = startupPoll;
      void startupPoll.finally(() => {
        if (pollInFlight === startupPoll) pollInFlight = null;
        scheduleNextPoll();
      });
    })
    .catch((error) => logError('Queue events init failed', error, { queue: queueName }));

  return {
    stop() {
      stopped = true;
      if (pollInterval) {
        clearTimeout(pollInterval);
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
