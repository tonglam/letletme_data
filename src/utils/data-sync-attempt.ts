import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  getFplAdmissionBatchMetricsSnapshot,
  hasFplAdmissionMetricsContext,
  runWithFplAdmissionMetrics,
  type FplAdmissionBatchMetrics,
} from './fpl-admission';
import {
  getFplRequestMetricsSnapshot,
  hasFplRequestMetricsContext,
  runWithFplRequestMetrics,
  type FplRequestMetricsSnapshot,
} from './fpl-request-metrics';
import { logError, logInfo } from './logger';
import { parseStrictBooleanEnvValue } from './config';
import { isPlayerValuesWindowPendingError } from '../domain/player-values-window';
import type { FplSeasonRef } from '../domain/fpl-season';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { DatabaseError } from './errors';
import { runtimeReleaseRevision } from './runtime-heartbeat';

export const DATA_SYNC_ATTEMPT_OUTCOMES = [
  'ready',
  'partial',
  'failed',
  'noop',
  'pending',
] as const;
export type DataSyncAttemptOutcome = (typeof DATA_SYNC_ATTEMPT_OUTCOMES)[number];

export type DataSyncAttemptSource =
  | 'cron'
  | 'manual'
  | 'api'
  | 'retry'
  | 'watchdog'
  | 'coordinator';

export interface DataSyncAttemptContext {
  queue: string;
  jobName: string;
  runId: string;
  /** Stable batch identity used by entry-scope workers and later cost ledgers. */
  batchId?: string;
  source?: string;
  attempt?: number;
  targetEventId?: number;
  /** Canonical season scope for the batch-cost ledger. */
  season?: FplSeasonRef;
  queueWaitMs?: number | null;
  /** Stable parent/batch identity for persisted cost accounting. */
  parentRunId?: string;
  executionIntent?: 'refresh' | 'retry' | 'force' | 'reconcile' | 'unknown';
  releaseSha?: string;
  /** Internal hook used to persist an event resolved after the running marker. */
  onTargetEventResolved?: (eventId: number) => unknown | Promise<unknown>;
}

export interface DataSyncWorkSummary {
  outcome?: DataSyncAttemptOutcome;
  requiredUnits?: number;
  reusedUnits?: number;
  succeededUnits?: number;
  failedUnits?: number;
  timings?: DataSyncPhaseTimings;
  insertedRows?: number;
  updatedRows?: number;
  deletedRows?: number;
  submittedRows?: number;
  publicationsCreated?: number;
  publicationsReused?: number;
  /** Set only when the caller supplied stable unit identities. */
  unitAccounting?: 'exact' | 'per_attempt';
}

export type DataSyncPhaseTimings = Partial<
  Record<'bootstrap' | 'snapshotWrite' | 'derivedView', number>
>;

export type DataSyncAttemptTimings = DataSyncPhaseTimings & {
  queueWait: number;
  total: number;
};

export function resolveDataSyncAttempt(
  source: string | undefined,
  attemptsMade: number,
  retryCount = 0,
): { attempt: number; source: string | undefined } {
  const boundedAttemptsMade = Math.max(0, Math.floor(attemptsMade));
  const boundedRetryCount = Math.max(0, Math.floor(retryCount));
  const attempt = boundedRetryCount + boundedAttemptsMade + 1;
  return {
    attempt,
    source: attempt > 1 ? 'retry' : source,
  };
}

export function resolveBullMqAttemptQueueWaitMs(
  timing: { timestamp: number; processedOn?: number; attemptsMade: number; delay?: number },
  now = Date.now(),
): number {
  const processedOn = timing.processedOn ?? now;
  if (timing.attemptsMade === 0) {
    const scheduledDelay = Math.max(0, Math.floor(timing.delay ?? 0));
    return Math.max(0, Math.floor(processedOn - timing.timestamp - scheduledDelay));
  }

  // BullMQ retains the original job timestamp across automatic retries and
  // does not expose a new queued-at timestamp. Use this attempt's activation
  // time so retry reports never include earlier execution and backoff time.
  return Math.max(0, Math.floor(now - processedOn));
}

export interface DataSyncAttemptReport {
  event: 'data_sync_attempt';
  queue: string;
  jobName: string;
  runId: string;
  batchId?: string;
  parentRunId?: string;
  executionIntent?: DataSyncAttemptContext['executionIntent'];
  source: DataSyncAttemptSource;
  attempt: number;
  targetEventId?: number;
  seasonId?: number;
  seasonCode?: string;
  outcome: DataSyncAttemptOutcome;
  queueWaitMs: number;
  durationMs: number;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
  timings: DataSyncAttemptTimings;
  fpl: FplRequestMetricsSnapshot;
  admission: FplAdmissionBatchMetrics;
  batchCost: {
    attemptKey: string;
    executionId: string;
    batchId: string;
    ledgerRunId: string;
    complete: boolean;
  };
}

type ReportOptions<T> = {
  summarize?: (result: T) => DataSyncWorkSummary;
  enabled?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Preserve committed work counters when a later delivery/reconciliation step fails. */
export function attachDataSyncCostEvidence(
  error: unknown,
  evidence: Record<string, unknown>,
): void {
  if (typeof error === 'object' && error !== null && Object.isExtensible(error)) {
    Object.assign(error, evidence);
  }
}

function boundedUnit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function boundedAttempt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

function firstBoundedUnit(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

function readOutcome(value: unknown): DataSyncAttemptOutcome | undefined {
  return typeof value === 'string' &&
    DATA_SYNC_ATTEMPT_OUTCOMES.includes(value as DataSyncAttemptOutcome)
    ? (value as DataSyncAttemptOutcome)
    : undefined;
}

const DATA_SYNC_PHASE_KEYS = ['bootstrap', 'snapshotWrite', 'derivedView'] as const;

function readPhaseTimings(value: unknown): DataSyncPhaseTimings | undefined {
  if (!isRecord(value)) return undefined;
  const timings: DataSyncPhaseTimings = {};
  for (const key of DATA_SYNC_PHASE_KEYS) {
    const duration = value[key];
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
      timings[key] = Math.round(duration);
    }
  }
  return Object.keys(timings).length > 0 ? timings : undefined;
}

export function inferDataSyncWorkSummary(result: unknown): DataSyncWorkSummary {
  if (!isRecord(result)) return {};

  const persistence = isRecord(result.persistence) ? result.persistence : undefined;
  const persistenceRows = persistence
    ? Object.values(persistence).reduce<number>(
        (total, value) => total + (typeof value === 'number' && Number.isFinite(value) ? value : 0),
        0,
      )
    : undefined;

  const explicitRequiredUnits = firstBoundedUnit(
    result.requiredUnits,
    result.totalEntries,
    result.sourceEntries,
    result.total,
  );
  const explicitSucceededUnits = firstBoundedUnit(
    result.succeededUnits,
    result.enqueued,
    result.synced,
    result.updated,
    result.upserted,
    result.inserted,
    result.success,
    result.count,
    result.totalCount,
  );
  const explicitFailedUnits = firstBoundedUnit(
    result.failedUnits,
    result.failed,
    result.errors,
    result.totalErrors,
  );
  const hasUnitEvidence =
    explicitRequiredUnits !== undefined ||
    explicitSucceededUnits !== undefined ||
    explicitFailedUnits !== undefined ||
    firstBoundedUnit(result.reusedUnits, result.skipped) !== undefined;
  const reusedUnits =
    firstBoundedUnit(result.reusedUnits, result.skipped) ?? (hasUnitEvidence ? 0 : undefined);
  const failedUnits =
    explicitFailedUnits ??
    (explicitRequiredUnits !== undefined && explicitSucceededUnits !== undefined
      ? Math.max(0, explicitRequiredUnits - explicitSucceededUnits - (reusedUnits ?? 0))
      : hasUnitEvidence && explicitSucceededUnits !== undefined
        ? 0
        : undefined);
  const succeededUnits =
    explicitSucceededUnits ??
    (explicitRequiredUnits !== undefined && failedUnits !== undefined
      ? Math.max(0, explicitRequiredUnits - (reusedUnits ?? 0) - failedUnits)
      : undefined);
  const requiredUnits =
    explicitRequiredUnits ??
    (succeededUnits !== undefined && reusedUnits !== undefined && failedUnits !== undefined
      ? Math.max(0, succeededUnits + reusedUnits + failedUnits)
      : undefined);
  const explicitOutcome = readOutcome(result.outcome);
  const timings = readPhaseTimings(result.timings);
  const insertedRows = firstBoundedUnit(result.insertedRows, persistence?.insertedRows);
  const updatedRows = firstBoundedUnit(result.updatedRows, persistence?.updatedRows);
  const deletedRows = firstBoundedUnit(result.deletedRows, persistence?.deletedRows);
  const submittedRows = firstBoundedUnit(
    result.submittedRows,
    result.marketSnapshotCount,
    persistenceRows,
  );
  const publicationsCreated = firstBoundedUnit(
    result.publicationsCreated,
    isRecord(result.publication) || typeof result.publicationId === 'string' ? 1 : undefined,
  );
  const publicationsReused = firstBoundedUnit(result.publicationsReused);
  const unitAccounting =
    result.unitAccounting === 'exact' || result.unitAccounting === 'per_attempt'
      ? result.unitAccounting
      : undefined;

  return {
    ...(explicitOutcome ? { outcome: explicitOutcome } : {}),
    requiredUnits,
    reusedUnits,
    succeededUnits,
    failedUnits,
    ...(timings ? { timings } : {}),
    ...(insertedRows !== undefined ? { insertedRows } : {}),
    ...(updatedRows !== undefined ? { updatedRows } : {}),
    ...(deletedRows !== undefined ? { deletedRows } : {}),
    ...(submittedRows !== undefined ? { submittedRows } : {}),
    ...(publicationsCreated !== undefined ? { publicationsCreated } : {}),
    ...(publicationsReused !== undefined ? { publicationsReused } : {}),
    ...(unitAccounting ? { unitAccounting } : {}),
  };
}

function normalizeSource(context: DataSyncAttemptContext): DataSyncAttemptSource {
  if (boundedAttempt(context.attempt) > 1 || context.source === 'retry') return 'retry';
  if (context.source === 'cron') return 'cron';
  if (context.source === 'api') return 'api';
  if (context.source === 'watchdog') return 'watchdog';
  if (context.source === 'cascade' || context.source === 'event-transition') return 'coordinator';
  if (context.source === 'coordinator') return 'coordinator';
  return 'manual';
}

function reportingEnabled(): boolean {
  return parseStrictBooleanEnvValue(
    process.env.DATA_SYNC_ATTEMPT_REPORTING_ENABLED,
    true,
    'DATA_SYNC_ATTEMPT_REPORTING_ENABLED',
  );
}

function stableAttemptKey(context: DataSyncAttemptContext, executionId: string): string {
  const batchId = context.batchId ?? context.runId;
  return [
    context.queue,
    context.jobName,
    batchId,
    boundedAttempt(context.attempt),
    context.targetEventId ?? 'none',
    executionId,
  ]
    .map((value) => String(value).replaceAll('|', '_'))
    .join('|');
}

function executionIntent(context: DataSyncAttemptContext): string {
  if (context.executionIntent) return context.executionIntent;
  if (boundedAttempt(context.attempt) > 1 || context.source === 'retry') return 'retry';
  if (context.source === 'manual' || context.source === 'api') return 'force';
  if (
    context.source === 'watchdog' ||
    context.source === 'reconcile' ||
    context.source === 'catchup' ||
    context.source === 'cascade' ||
    context.source === 'event-transition' ||
    context.source === 'coordinator'
  ) {
    return 'reconcile';
  }
  return 'refresh';
}

function nullableNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** The ops ledger accepts only positive FPL event identities. Some legacy
 * tournament jobs use zero as an internal "unscoped" sentinel; keep that
 * sentinel out of durable scope and let the worker resolve the real event. */
function ledgerTargetEventId(context: DataSyncAttemptContext): number | undefined {
  const eventId = context.targetEventId;
  return typeof eventId === 'number' && Number.isSafeInteger(eventId) && eventId > 0
    ? eventId
    : undefined;
}

function batchCostPayload(
  context: DataSyncAttemptContext,
  report: Omit<DataSyncAttemptReport, 'batchCost'>,
  complete: boolean,
  summary: DataSyncWorkSummary,
  startedAtIso: string,
  executionId: string,
): Record<string, unknown> {
  const admission = report.admission;
  const writeFields = [
    summary.insertedRows,
    summary.updatedRows,
    summary.deletedRows,
    summary.publicationsCreated,
    summary.publicationsReused,
  ];
  const unitFields = [
    summary.requiredUnits,
    summary.reusedUnits,
    summary.succeededUnits,
    summary.failedUnits,
  ];
  return {
    job: context.jobName,
    queue: context.queue,
    eventId: ledgerTargetEventId(context) ?? null,
    seasonId: context.season?.seasonId ?? null,
    seasonCode: context.season?.seasonCode ?? null,
    executionId,
    executionIntent: executionIntent(context),
    startedAt: startedAtIso,
    settledAt: new Date().toISOString(),
    complete,
    outcome: report.outcome,
    logicalRequests: report.fpl.logicalRequests,
    httpAttempts: report.fpl.attempts,
    httpRetries: report.fpl.retries,
    endpointRequests: report.fpl.byEndpoint,
    requiredUnits: nullableNumber(summary.requiredUnits),
    reusedUnits: nullableNumber(summary.reusedUnits),
    succeededUnits: nullableNumber(summary.succeededUnits),
    failedUnits: nullableNumber(summary.failedUnits),
    unitAccounting: summary.unitAccounting ?? 'per_attempt',
    unitAccountingQuality: unitFields.every((value) => nullableNumber(value) !== null)
      ? 'reported'
      : 'unknown',
    insertedRows: nullableNumber(summary.insertedRows),
    updatedRows: nullableNumber(summary.updatedRows),
    deletedRows: nullableNumber(summary.deletedRows),
    submittedRows: nullableNumber(summary.submittedRows),
    publicationsCreated: nullableNumber(summary.publicationsCreated),
    publicationsReused: nullableNumber(summary.publicationsReused),
    writeAccounting: writeFields.every((value) => nullableNumber(value) !== null)
      ? 'reported'
      : 'unknown',
    admissionWaitMs: Math.max(0, Math.floor(admission.waitMsTotal)),
    admissionWaitSamples: admission.waitSamples,
    admissionGrants: admission.grants,
    admissionRejected: admission.deadlineExceeded,
    admissionStoreUnavailable: admission.storeUnavailable,
    admissionCancelled: admission.cancelled,
    providerResponseSamples: admission.responseSamples,
    providerResponse429: admission.response429,
    providerResponse5xx: admission.response5xx,
    providerNetworkErrors: admission.networkErrors,
    providerDurationMs: Math.max(0, Math.floor(admission.providerDurationMsTotal)),
    providerDurationSamples: admission.providerDurationSamples,
    timings: report.timings,
    ...(complete ? {} : { incompleteReason: 'attempt_failed_before_cost_settlement' }),
  };
}

function batchCostLedgerRunId(context: DataSyncAttemptContext): string {
  const identity = JSON.stringify([
    'data-sync-batch-cost',
    context.queue,
    context.jobName,
    context.runId,
    context.batchId ?? context.runId,
  ]);
  const bytes = createHash('sha256').update(identity).digest('hex').slice(0, 32).split('');
  bytes[12] = '4';
  bytes[16] = ['8', '9', 'a', 'b'][Number.parseInt(bytes[16]!, 16) % 4]!;
  return `${bytes.slice(0, 8).join('')}-${bytes.slice(8, 12).join('')}-${bytes.slice(12, 16).join('')}-${bytes.slice(16, 20).join('')}-${bytes.slice(20).join('')}`;
}

export async function reconcileDataSyncBatchCostAfterTerminalFailure(input: {
  queue: string;
  jobName: string;
  runId: string;
  batchId: string;
  attempt: number;
  error: unknown;
}): Promise<boolean> {
  const context: DataSyncAttemptContext = {
    queue: input.queue,
    jobName: input.jobName,
    runId: input.runId,
    batchId: input.batchId,
    attempt: input.attempt,
  };
  return syncOperationsRepository.reconcileBatchCostTerminalFailure(batchCostLedgerRunId(context), {
    batchId: input.batchId,
    attempt: boundedAttempt(input.attempt),
    error: input.error,
  });
}

async function ensureBatchCostLedgerRun(
  context: DataSyncAttemptContext,
  ledgerRunId: string,
): Promise<void> {
  const releaseSha = context.releaseSha ?? runtimeReleaseRevision();
  await syncOperationsRepository.startRun({
    runId: ledgerRunId,
    provider: 'fpl',
    lane: context.queue,
    scope: context.jobName,
    season: context.season,
    eventId: ledgerTargetEventId(context),
    mode: 'batch-cost',
    // Keep this identity constant across Bull retries. The original source
    // and run IDs remain in metadata/payload and never participate in the
    // immutable sync-run identity check.
    trigger: 'batch-cost',
    metadata: {
      batchCostLedger: true,
      originalRunId: context.runId,
      batchId: context.batchId ?? context.runId,
      parentRunId: context.parentRunId ?? null,
      source: context.source ?? null,
      releaseSha,
      seasonId: context.season?.seasonId ?? null,
      seasonCode: context.season?.seasonCode ?? null,
      eventId: ledgerTargetEventId(context) ?? null,
    },
  });
}

async function persistBatchCost(
  context: DataSyncAttemptContext,
  report: Omit<DataSyncAttemptReport, 'batchCost'>,
  attemptKey: string,
  complete: boolean,
  summary: DataSyncWorkSummary,
  startedAtIso: string,
  executionId: string,
): Promise<string> {
  const ledgerRunId = batchCostLedgerRunId(context);
  await ensureBatchCostLedgerRun(context, ledgerRunId);
  const recorded = await syncOperationsRepository.recordBatchCost(ledgerRunId, {
    attemptKey,
    batchId: context.batchId ?? context.runId,
    parentRunId: context.parentRunId ?? null,
    releaseSha: context.releaseSha ?? runtimeReleaseRevision(),
    attempt: boundedAttempt(context.attempt),
    complete,
    payload: {
      originalRunId: context.runId,
      ledgerRunId,
      ...batchCostPayload(context, report, complete, summary, startedAtIso, executionId),
    },
  });
  if (recorded === 'missing') throw new Error(`Batch cost ledger run ${ledgerRunId} disappeared`);
  // recordBatchCost settles the dedicated ledger run in the same transaction
  // as the attempt item and aggregate totals. Its attempt fence prevents a
  // late failure from overwriting a newer attempt's completion.
  return ledgerRunId;
}

async function persistBatchCostStart(
  context: DataSyncAttemptContext,
  attemptKey: string,
  startedAtIso: string,
  executionId: string,
): Promise<string> {
  const ledgerRunId = batchCostLedgerRunId(context);
  await ensureBatchCostLedgerRun(context, ledgerRunId);
  const recorded = await syncOperationsRepository.recordBatchCostStart(ledgerRunId, {
    attemptKey,
    batchId: context.batchId ?? context.runId,
    parentRunId: context.parentRunId ?? null,
    releaseSha: context.releaseSha ?? runtimeReleaseRevision(),
    attempt: boundedAttempt(context.attempt),
    payload: {
      originalRunId: context.runId,
      ledgerRunId,
      job: context.jobName,
      queue: context.queue,
      eventId: context.targetEventId ?? null,
      seasonId: context.season?.seasonId ?? null,
      seasonCode: context.season?.seasonCode ?? null,
      executionId,
      executionIntent: executionIntent(context),
      startedAt: startedAtIso,
    },
  });
  if (recorded === 'missing') throw new Error(`Batch cost ledger run ${ledgerRunId} disappeared`);
  return ledgerRunId;
}

function resolveOutcome(summary: DataSyncWorkSummary): DataSyncAttemptOutcome {
  if (summary.outcome) return summary.outcome;
  return boundedUnit(summary.failedUnits) > 0 ? 'partial' : 'ready';
}

export async function runDataSyncAttempt<T>(
  context: DataSyncAttemptContext,
  runner: () => Promise<T>,
  options: ReportOptions<T> = {},
): Promise<T> {
  if (options.enabled === false || !reportingEnabled()) {
    return runner();
  }

  const nestedMetricsContext = hasFplRequestMetricsContext() || hasFplAdmissionMetricsContext();
  return runWithFplRequestMetrics(() =>
    runWithFplAdmissionMetrics(async () => {
      const startedAt = performance.now();
      const startedAtIso = new Date().toISOString();
      const executionId = randomUUID();
      let summary: DataSyncWorkSummary = {};
      let outcome: DataSyncAttemptOutcome = 'failed';
      let targetEventId = context.targetEventId;
      let settledSuccessfully = false;

      const attemptKey = stableAttemptKey(context, executionId);
      let batchCostRunId: string | undefined;
      try {
        if (!nestedMetricsContext) {
          try {
            // Compute the deterministic ledger identity before the first
            // database call. If that call writes the running marker and then
            // fails with an ambiguous response, the finally block can still
            // fence and close the marker.
            batchCostRunId = batchCostLedgerRunId(context);
            batchCostRunId = await persistBatchCostStart(
              context,
              attemptKey,
              startedAtIso,
              executionId,
            );
          } catch (error) {
            logError('Failed to persist data sync batch cost start', error, {
              runId: context.runId,
              attemptKey,
            });
          }
        }
        const previousTargetResolver = context.onTargetEventResolved;
        context.onTargetEventResolved = async (eventId: number) => {
          await previousTargetResolver?.(eventId);
          if (!batchCostRunId) {
            context.targetEventId = eventId;
            return;
          }
          try {
            const updated = await syncOperationsRepository.updateBatchCostTargetEvent(
              batchCostRunId,
              attemptKey,
              eventId,
            );
            if (!updated) {
              throw new DatabaseError(
                `Batch cost target event ${eventId} conflicts with the existing event scope`,
                'SYNC_BATCH_COST_EVENT_CONFLICT',
              );
            }
            context.targetEventId = eventId;
          } catch (error) {
            if (error instanceof DatabaseError && error.code === 'SYNC_BATCH_COST_EVENT_CONFLICT') {
              throw error;
            }
            logError('Failed to persist resolved data sync target event', error, {
              runId: context.runId,
              attemptKey,
              eventId,
            });
          }
        };
        const result = await runner();
        // Some unscoped workers resolve their canonical event inside the runner
        // immediately before taking database mutation scopes. The context is shared by
        // reference, so adopt that resolution before falling back to the result.
        targetEventId ??= context.targetEventId;
        if (targetEventId === undefined && isRecord(result)) {
          targetEventId = firstBoundedUnit(result.eventId);
          if (targetEventId !== undefined) {
            await context.onTargetEventResolved?.(targetEventId);
          }
        }
        summary = options.summarize?.(result) ?? inferDataSyncWorkSummary(result);
        outcome = resolveOutcome(summary);
        settledSuccessfully = true;
        return result;
      } catch (error) {
        // Bounded operational errors may carry useful unit counters. The market
        // window's expected no-change wait is reported as pending, not failed.
        summary = {
          ...inferDataSyncWorkSummary(error),
          ...(isPlayerValuesWindowPendingError(error) ? { outcome: 'pending' as const } : {}),
        };
        if (isPlayerValuesWindowPendingError(error)) outcome = 'pending';
        throw error;
      } finally {
        // Preserve the resolved target even when the runner fails after lookup;
        // the failure report still needs to identify the bounded event unit.
        targetEventId ??= context.targetEventId;
        if (targetEventId !== undefined) context.targetEventId = targetEventId;
        const reportTargetEventId = ledgerTargetEventId(context);
        const reportBase: Omit<DataSyncAttemptReport, 'batchCost'> = {
          event: 'data_sync_attempt',
          queue: context.queue,
          jobName: context.jobName,
          runId: context.runId,
          ...(context.batchId !== undefined ? { batchId: context.batchId } : {}),
          ...(context.parentRunId !== undefined ? { parentRunId: context.parentRunId } : {}),
          ...(context.executionIntent !== undefined
            ? { executionIntent: context.executionIntent }
            : {}),
          source: normalizeSource(context),
          attempt: boundedAttempt(context.attempt),
          ...(reportTargetEventId !== undefined ? { targetEventId: reportTargetEventId } : {}),
          ...(context.season
            ? { seasonId: context.season.seasonId, seasonCode: context.season.seasonCode }
            : {}),
          outcome,
          queueWaitMs: Math.max(0, Math.floor(context.queueWaitMs ?? 0)),
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          requiredUnits: boundedUnit(summary.requiredUnits),
          reusedUnits: boundedUnit(summary.reusedUnits),
          succeededUnits: boundedUnit(summary.succeededUnits),
          failedUnits: boundedUnit(summary.failedUnits),
          timings: {
            queueWait: Math.max(0, Math.floor(context.queueWaitMs ?? 0)),
            total: Math.max(0, Math.round(performance.now() - startedAt)),
            ...summary.timings,
          },
          fpl: getFplRequestMetricsSnapshot(),
          admission: getFplAdmissionBatchMetricsSnapshot(),
        };
        const report: DataSyncAttemptReport = {
          ...reportBase,
          batchCost: {
            attemptKey,
            executionId,
            batchId: context.batchId ?? context.runId,
            ledgerRunId: batchCostLedgerRunId(context),
            complete: settledSuccessfully,
          },
        };

        logInfo('Data sync attempt', report);
        if (!nestedMetricsContext) {
          try {
            await persistBatchCost(
              context,
              reportBase,
              attemptKey,
              settledSuccessfully,
              summary,
              startedAtIso,
              executionId,
            );
          } catch (error) {
            // Cost accounting is observability. Close the durable running
            // marker when settlement itself fails, then keep the business
            // result unchanged. The marker records an incomplete accounting
            // outcome instead of leaving queue quiescence blocked forever.
            if (batchCostRunId) {
              await syncOperationsRepository
                .markBatchCostSettlementFailure(batchCostRunId, {
                  attemptKey,
                  attempt: boundedAttempt(context.attempt),
                  error,
                })
                .catch((recoveryError) => {
                  logError('Failed to close data sync batch cost marker', recoveryError, {
                    runId: context.runId,
                    attemptKey,
                  });
                });
            }
            logError('Failed to persist data sync batch cost', error, {
              runId: context.runId,
              attemptKey,
            });
          }
        }
      }
    }),
  );
}
