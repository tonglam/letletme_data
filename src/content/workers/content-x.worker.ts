import { randomUUID } from 'node:crypto';

import { getContentRuntimeFlags, assertContentRuntimeFlags } from '../config';
import {
  CliGrokRunner,
  FixtureGrokRunner,
  MONITOR_FPL_X_SOURCES_SKILL_SHA,
  type GrokRunner,
} from '../acquisition/grok-runner';
import { buildSourceSnapshot } from '../acquisition/source-registry';
import {
  beginAcquisitionRun,
  finishAcquisitionRun,
  reserveXCallBudget,
  type AcquisitionRunInput,
} from '../acquisition/run-repository';
import { logInfo } from '../../utils/logger';

export function createContentXRunner(): GrokRunner {
  const flags = getContentRuntimeFlags();
  assertContentRuntimeFlags(flags);
  if (!flags.realGrokEnabled) return new FixtureGrokRunner();
  return new CliGrokRunner();
}

export type ContentXWorkerInput = Readonly<{
  groupKey?: string;
  partitionKey?: string;
  mode?: 'poll' | 'enrich' | 'compose';
  pollPhase?: 'NORMAL' | 'APPROACHING' | 'FINAL_90';
  windowStart?: string;
  windowEnd?: string;
}>;

export async function runContentXWorker(input: ContentXWorkerInput = {}): Promise<{
  status: 'DISABLED' | 'REUSED' | 'EMPTY' | 'PARTIAL' | 'COMPLETED' | 'FAILED';
  runId?: string;
}> {
  const flags = getContentRuntimeFlags();
  assertContentRuntimeFlags(flags);
  if (!flags.pipelineEnabled) return { status: 'DISABLED' };

  const groupKey = input.groupKey ?? process.env.CONTENT_SOURCE_GROUP_KEY ?? 'fpl-week';
  const partitionKey = input.partitionKey ?? process.env.CONTENT_PARTITION_KEY ?? 'week';
  const mode = input.mode ?? 'poll';
  const pollPhase = input.pollPhase ?? 'NORMAL';
  const windowEnd = input.windowEnd ?? new Date().toISOString();
  const windowStart =
    input.windowStart ?? new Date(Date.parse(windowEnd) - 30 * 60_000).toISOString();
  const snapshot = await buildSourceSnapshot(groupKey);
  const idempotencyKey = `briefing:x:${groupKey}:${partitionKey}:${mode}:${pollPhase}:${windowEnd}`;
  const run: AcquisitionRunInput = {
    runId: randomUUID(),
    groupId: snapshot.groupId,
    partitionKey,
    mode,
    windowStart,
    windowEnd,
    idempotencyKey,
    sourceSnapshotRevision: snapshot.revision,
    sourceSnapshot: snapshot.items,
  };
  const started = await beginAcquisitionRun(run);
  if (started.reused) return { status: 'REUSED', runId: started.runId };

  if (
    !(await reserveXCallBudget({
      groupId: snapshot.groupId,
      windowStart,
      dailyBudget: flags.dailyXCallBudget,
      requestedXCalls: flags.pollMaxXCalls,
    }))
  ) {
    const result = await finishAcquisitionRun({
      run,
      result: {
        status: 'FAILED',
        traceVerified: false,
        xCallCount: 0,
        receipts: [],
        error: 'X call budget exhausted',
        skillSha: '',
      },
    });
    return { status: result.status.toUpperCase() as 'FAILED', runId: run.runId };
  }

  const result = await createContentXRunner().run({
    mode,
    profile: 'week',
    runId: run.runId,
    sourceSnapshotRevision: snapshot.revision,
    sources: snapshot.items,
    windowStart,
    windowEnd,
    maxXCalls: flags.pollMaxXCalls,
  });
  const normalized =
    result.xCallCount > flags.pollMaxXCalls ||
    !result.traceVerified ||
    (flags.realGrokEnabled && result.skillSha !== MONITOR_FPL_X_SOURCES_SKILL_SHA)
      ? {
          ...result,
          status: 'FAILED' as const,
          error:
            result.error ??
            (flags.realGrokEnabled && result.skillSha !== MONITOR_FPL_X_SOURCES_SKILL_SHA
              ? 'Unexpected Grok skill SHA'
              : 'Missing verified X tool trace'),
        }
      : result;
  const finished = await finishAcquisitionRun({ run, result: normalized });
  logInfo('Content X acquisition run completed', {
    runId: run.runId,
    groupKey,
    partitionKey,
    status: finished.status,
    traceVerified: normalized.traceVerified,
    xCallCount: normalized.xCallCount,
    receiptCount: finished.receiptCount,
    checkpointAdvanced: finished.checkpointAdvanced,
  });
  return {
    status: finished.status.toUpperCase() as 'EMPTY' | 'PARTIAL' | 'COMPLETED' | 'FAILED',
    runId: run.runId,
  };
}
