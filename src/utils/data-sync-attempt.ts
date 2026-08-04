import { performance } from 'node:perf_hooks';

import {
  getFplRequestMetricsSnapshot,
  runWithFplRequestMetrics,
  type FplRequestMetricsSnapshot,
} from './fpl-request-metrics';
import { logInfo } from './logger';

export const DATA_SYNC_ATTEMPT_OUTCOMES = ['ready', 'partial', 'failed', 'noop'] as const;
export type DataSyncAttemptOutcome = (typeof DATA_SYNC_ATTEMPT_OUTCOMES)[number];

export type DataSyncAttemptSource = 'cron' | 'manual' | 'retry' | 'watchdog' | 'coordinator';

export interface DataSyncAttemptContext {
  queue: string;
  jobName: string;
  runId: string;
  source?: string;
  attempt?: number;
  targetEventId?: number;
  queueWaitMs?: number | null;
}

export interface DataSyncWorkSummary {
  outcome?: DataSyncAttemptOutcome;
  requiredUnits?: number;
  reusedUnits?: number;
  succeededUnits?: number;
  failedUnits?: number;
}

export interface DataSyncAttemptReport {
  event: 'data_sync_attempt';
  schemaVersion: 1;
  queue: string;
  jobName: string;
  runId: string;
  source: DataSyncAttemptSource;
  targetEventId?: number;
  outcome: DataSyncAttemptOutcome;
  queueWaitMs: number;
  durationMs: number;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
  fpl: FplRequestMetricsSnapshot;
}

type ReportOptions<T> = {
  summarize?: (result: T) => DataSyncWorkSummary;
  enabled?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedUnit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readOutcome(value: unknown): DataSyncAttemptOutcome | undefined {
  return typeof value === 'string' &&
    DATA_SYNC_ATTEMPT_OUTCOMES.includes(value as DataSyncAttemptOutcome)
    ? (value as DataSyncAttemptOutcome)
    : undefined;
}

export function inferDataSyncWorkSummary(result: unknown): DataSyncWorkSummary {
  if (!isRecord(result)) return {};

  const failedUnits = boundedUnit(result.failedUnits ?? result.failed ?? result.errors);
  const requiredUnits = boundedUnit(result.requiredUnits ?? result.total);
  const succeededUnits = boundedUnit(result.succeededUnits ?? result.success);
  const reusedUnits = boundedUnit(result.reusedUnits);
  const explicitOutcome = readOutcome(result.outcome);

  return {
    ...(explicitOutcome ? { outcome: explicitOutcome } : {}),
    requiredUnits,
    reusedUnits,
    succeededUnits,
    failedUnits,
  };
}

function normalizeSource(context: DataSyncAttemptContext): DataSyncAttemptSource {
  if ((context.attempt ?? 1) > 1 || context.source === 'retry') return 'retry';
  if (context.source === 'cron') return 'cron';
  if (context.source === 'watchdog') return 'watchdog';
  if (context.source === 'cascade' || context.source === 'event-transition') return 'coordinator';
  if (context.source === 'coordinator') return 'coordinator';
  return 'manual';
}

function reportingEnabled(): boolean {
  const value = process.env.DATA_SYNC_ATTEMPT_REPORTING_ENABLED;
  return value === undefined || !['false', '0', 'off', 'no'].includes(value.toLowerCase());
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

  return runWithFplRequestMetrics(async () => {
    const startedAt = performance.now();
    let summary: DataSyncWorkSummary = {};
    let outcome: DataSyncAttemptOutcome = 'failed';

    try {
      const result = await runner();
      summary = options.summarize?.(result) ?? inferDataSyncWorkSummary(result);
      outcome = resolveOutcome(summary);
      return result;
    } finally {
      const report: DataSyncAttemptReport = {
        event: 'data_sync_attempt',
        schemaVersion: 1,
        queue: context.queue,
        jobName: context.jobName,
        runId: context.runId,
        source: normalizeSource(context),
        ...(context.targetEventId !== undefined ? { targetEventId: context.targetEventId } : {}),
        outcome,
        queueWaitMs: Math.max(0, Math.floor(context.queueWaitMs ?? 0)),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        requiredUnits: boundedUnit(summary.requiredUnits),
        reusedUnits: boundedUnit(summary.reusedUnits),
        succeededUnits: boundedUnit(summary.succeededUnits),
        failedUnits: boundedUnit(summary.failedUnits),
        fpl: getFplRequestMetricsSnapshot(),
      };

      logInfo('Data sync attempt', report);
    }
  });
}
