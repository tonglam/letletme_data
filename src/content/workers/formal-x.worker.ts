import { sql } from 'drizzle-orm';

import {
  getAcquisitionProfile,
  X_ACQUISITION_LANES,
  type XAcquisitionLane,
} from '../acquisition/acquisition-profiles';
import { sha256CanonicalJson } from '../acquisition/canonicalization';
import { acquisitionJobV1Schema, type AcquisitionJobV1 } from '../acquisition/formal-run-contract';
import { beginFormalRun, failFormalRun } from '../acquisition/formal-run-repository';
import {
  GrokBuildExecutor,
  type GrokBuildExecutionResult,
  type GrokBuildExecutionHooks,
} from '../acquisition/grok-build-executor';
import { persistAcquisitionResult } from '../acquisition/receipt-repository';
import { resolveSemanticXAuthors } from '../acquisition/semantic-author-resolver';
import {
  adaptGrokBuildPosts,
  adaptGrokBuildSemanticPosts,
  prevalidateGrokBuildPostsForAuthorResolution,
  XPostQualityError,
} from '../acquisition/x-post-adapter';
import { failXIdentityRun, persistXIdentityResult } from '../acquisition/x-identity-repository';
import type { XBudgetPolicy } from '../acquisition/x-budget';
import { compileXKeywordRequest } from '../acquisition/x-query-compiler';
import { getContentRuntimeFlags, type ContentRuntimeFlags } from '../config';
import { getDb, type DbHandle } from '../../db/singleton';

export type FormalXWorkerResult = Readonly<{
  runId: string;
  status:
    | 'REUSED'
    | 'EMPTY'
    | 'CHECKED_NO_CHANGE'
    | 'COMPLETED'
    | 'PARTIAL'
    | 'SATURATED'
    | 'GAP'
    | 'CONTENT_DEFERRED'
    | 'FAILED';
  receiptCount: number;
  revisionCount: number;
  outboxCount: number;
  returnedCount: number;
  rejectedCount: number;
}>;

export type GrokBuildExecutorLike = Readonly<{
  execute: (
    request: Parameters<GrokBuildExecutor['execute']>[0],
    hooks?: GrokBuildExecutionHooks,
  ) => Promise<GrokBuildExecutionResult>;
}>;

function errorFacts(error: unknown): { failureClass: string; summary: string } {
  const candidate = error as { failureClass?: unknown; message?: unknown };
  return {
    failureClass:
      typeof candidate?.failureClass === 'string' ? candidate.failureClass : 'X_ADAPTER_FAILED',
    summary: typeof candidate?.message === 'string' ? candidate.message : 'Formal X adapter failed',
  };
}

async function databaseNow(db: DbHandle): Promise<Date> {
  const rows = await db.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
  const value = rows[0]?.dbNow;
  const result = value instanceof Date ? value : new Date(value ?? Number.NaN);
  if (!Number.isFinite(result.getTime())) throw new Error('Database clock is invalid');
  return result;
}

export async function runFormalXWorker(
  rawJob: AcquisitionJobV1,
  dependencies?: Readonly<{
    flags?: ContentRuntimeFlags;
    executor?: GrokBuildExecutorLike;
    xBudgetPolicy?: XBudgetPolicy;
    db?: DbHandle;
  }>,
): Promise<FormalXWorkerResult> {
  const job = acquisitionJobV1Schema.parse(rawJob);
  const flags = dependencies?.flags ?? getContentRuntimeFlags();
  const db = dependencies?.db ?? (await getDb());
  let began = false;
  let identityRun = false;
  let providerProcessStarted = false;
  let identityExecution: GrokBuildExecutionResult | null = null;
  let scanExecution: GrokBuildExecutionResult | null = null;
  let scanAccounting: Readonly<{
    returned: number;
    accepted: number;
    rejected: number;
    saturated: boolean;
  }> | null = null;
  try {
    const run = await beginFormalRun({ runId: job.runId, db });
    if (run.status === 'TERMINAL') {
      return {
        runId: job.runId,
        status: 'REUSED',
        receiptCount: 0,
        revisionCount: 0,
        outboxCount: 0,
        returnedCount: 0,
        rejectedCount: 0,
      };
    }
    began = true;
    identityRun = run.request.jobKind === 'X_IDENTITY';
    if (!flags.pipelineEnabled || !flags.xScanEnabled || !flags.realGrokEnabled) {
      throw new Error('Formal Grok Build X acquisition is disabled');
    }
    if (
      run.request.jobKind !== 'X_IDENTITY' &&
      run.request.jobKind !== 'X_KEYWORD_SCAN' &&
      run.request.jobKind !== 'X_SEMANTIC_SCAN'
    ) {
      throw new Error(`X worker cannot execute ${run.request.jobKind}`);
    }
    const profile = getAcquisitionProfile(run.request.profileKey);
    if (!profile || profile.revision !== run.request.profileRevision) {
      throw new Error('Persisted X profile no longer matches versioned code');
    }
    const executor =
      dependencies?.executor ??
      new GrokBuildExecutor({
        expectedVersion: flags.grokExpectedVersion,
        timeoutMs: flags.grokTimeoutMs,
        maximumOutputBytes: flags.grokMaxOutputBytes,
      });
    if (run.request.jobKind === 'X_IDENTITY') {
      const execution = await executor.execute(run.request.toolRequest, {
        onProviderProcessStart: () => {
          providerProcessStarted = true;
        },
      });
      identityExecution = execution;
      const identity = await persistXIdentityResult({ runId: job.runId, execution, db });
      return {
        runId: job.runId,
        status: identity.status,
        receiptCount: 0,
        revisionCount: 0,
        outboxCount: 0,
        returnedCount: execution.users.length,
        rejectedCount: identity.status === 'FAILED' ? execution.users.length : 0,
      };
    }
    const scanRequest = run.request;
    if (
      (scanRequest.jobKind === 'X_KEYWORD_SCAN' &&
        scanRequest.toolRequest.toolName !== 'x_keyword_search') ||
      (scanRequest.jobKind === 'X_SEMANTIC_SCAN' &&
        scanRequest.toolRequest.toolName !== 'x_semantic_search')
    ) {
      throw new Error('Persisted X scan job and tool request do not agree');
    }
    const execution = await executor.execute(scanRequest.toolRequest, {
      onProviderProcessStart: () => {
        providerProcessStarted = true;
      },
    });
    scanExecution = execution;
    const checkedAt = await databaseNow(db);
    const semanticAuthors =
      scanRequest.jobKind === 'X_SEMANTIC_SCAN'
        ? await resolveSemanticXAuthors({
            posts: prevalidateGrokBuildPostsForAuthorResolution({
              request: scanRequest,
              execution,
            }),
            db,
          })
        : null;
    const adapted = semanticAuthors
      ? adaptGrokBuildSemanticPosts({
          request: scanRequest,
          execution,
          checkedAt,
          authors: semanticAuthors,
        })
      : adaptGrokBuildPosts({ request: scanRequest, execution, checkedAt });
    scanAccounting = {
      returned: adapted.returnedCount,
      accepted: adapted.acceptedCount,
      rejected: adapted.rejections.length,
      saturated: adapted.saturated,
    };
    let state: 'EMPTY' | 'COMPLETED' | 'PARTIAL' | 'SATURATED' | 'GAP' = adapted.stateHint;
    let acquisitionGap:
      | { windowStart: string; windowEnd: string; reason: string; detailsHash: string }
      | undefined;
    const oldestAcceptedAt = adapted.oldestAcceptedAt ? new Date(adapted.oldestAcceptedAt) : null;
    // X search bounds are second-precision and the evidence gate is
    // inclusive. Overlap the oldest accepted second (plus one second where
    // possible) so posts tied at the saturation boundary cannot disappear
    // between the parent and its one bounded follow-up. Receipt identity
    // deduplication makes the overlap harmless.
    const earlierWindowEnd =
      oldestAcceptedAt && scanRequest.windowEnd
        ? new Date(
            Math.min(Date.parse(scanRequest.windowEnd) - 1, oldestAcceptedAt.getTime() + 1_000),
          )
        : null;
    const hasEarlierWindow =
      earlierWindowEnd !== null &&
      earlierWindowEnd.getTime() >= Date.parse(scanRequest.windowStart);
    if (adapted.saturated && scanRequest.jobKind === 'X_SEMANTIC_SCAN') {
      acquisitionGap = {
        windowStart: scanRequest.windowStart,
        windowEnd: scanRequest.windowEnd,
        reason: 'SEMANTIC_RESULT_CAP',
        detailsHash: sha256CanonicalJson({
          returned: adapted.returnedCount,
          toolRequest: scanRequest.toolRequest,
        }),
      };
    } else if (adapted.saturated && run.parentRunId) {
      state = 'GAP';
      acquisitionGap = {
        windowStart: scanRequest.windowStart,
        windowEnd: hasEarlierWindow ? earlierWindowEnd.toISOString() : scanRequest.windowEnd,
        reason: 'SATURATION_FOLLOWUP_LIMIT',
        detailsHash: sha256CanonicalJson({
          parentRunId: run.parentRunId,
          returned: adapted.returnedCount,
          oldestAcceptedAt: adapted.oldestAcceptedAt,
        }),
      };
    }
    const followUpCandidate =
      adapted.saturated &&
      scanRequest.jobKind === 'X_KEYWORD_SCAN' &&
      !run.parentRunId &&
      hasEarlierWindow
        ? {
            ...scanRequest,
            windowEnd: earlierWindowEnd.toISOString(),
            toolRequest: compileXKeywordRequest({
              handles: scanRequest.partition.members.map((member) => member.locator.handle ?? ''),
              windowStart: new Date(scanRequest.windowStart),
              windowEnd: earlierWindowEnd,
              limit:
                scanRequest.toolRequest.toolName === 'x_keyword_search'
                  ? scanRequest.toolRequest.limit
                  : 10,
            }),
          }
        : null;
    const followUpRequest = followUpCandidate;
    if (followUpRequest && !dependencies?.xBudgetPolicy) {
      throw new Error(
        'Saturated X run cannot create a follow-up without an explicit budget policy',
      );
    }
    if (!X_ACQUISITION_LANES.includes(profile.lane as XAcquisitionLane)) {
      throw new Error('Persisted X profile has no valid budget lane');
    }
    const checkpointComplete = run.scheduleId !== null && state !== 'PARTIAL' && state !== 'GAP';
    const persisted = await persistAcquisitionResult({
      runId: job.runId,
      state,
      batches: adapted.batches,
      rejections: adapted.rejections,
      semanticAuthorEvidence: semanticAuthors
        ? Object.fromEntries(
            semanticAuthors.map((author) => [
              author.endpointKey,
              { authorHandle: author.authorHandle },
            ]),
          )
        : undefined,
      checkpointComplete,
      checkpoint: checkpointComplete
        ? {
            checkedAt: checkedAt.toISOString(),
            windowEnd: scanRequest.windowEnd,
            newestPostId: adapted.newestPostId,
          }
        : undefined,
      nextDueAt:
        run.scheduleId === null
          ? undefined
          : new Date(checkedAt.getTime() + profile.cadenceMinutes[run.request.phase] * 60_000),
      triggeredJobs: followUpRequest
        ? [
            {
              queueName: 'content-x-scan' as const,
              priority: profile.priority,
              request: followUpRequest,
            },
          ]
        : undefined,
      triggeredXBudget:
        followUpRequest && dependencies?.xBudgetPolicy
          ? {
              policy: dependencies.xBudgetPolicy,
              lane: profile.lane as XAcquisitionLane,
            }
          : undefined,
      acquisitionGap,
      providerTraces: [
        {
          sequence: 0,
          provider: 'grok-build',
          operation: execution.toolName,
          requestMetadataHash: execution.requestMetadataHash,
          responseMetadataHash: execution.responseMetadataHash,
          providerJobIdHash: execution.toolCallIdHash,
          providerUnits: 1,
          terminalState: 'ATTESTED_FINAL',
        },
      ],
      providerResult: { provider: 'grok-build', providerUnits: 1 },
      runMetrics: {
        durationMs: Math.round(execution.durationMs),
        eventCount: execution.eventCount,
        inputTokens: execution.inputTokens,
        outputTokens: execution.outputTokens,
        totalCostUsd: execution.totalCostUsd,
        returned: adapted.returnedCount,
        accepted: adapted.acceptedCount,
        rejected: adapted.rejections.length,
        saturated: adapted.saturated,
        rawPostEvidenceAvailable: execution.rawPostEvidenceAvailable,
        traceHash: execution.traceHash,
      },
      db,
    });
    return {
      runId: job.runId,
      status: persisted.state,
      receiptCount: persisted.receiptCount,
      revisionCount: persisted.revisionCount,
      outboxCount: persisted.outboxCount,
      returnedCount: adapted.returnedCount,
      rejectedCount: adapted.rejections.length,
    };
  } catch (error) {
    if (began) {
      const failure = errorFacts(error);
      if (identityRun) {
        await failXIdentityRun({
          runId: job.runId,
          failureClass: failure.failureClass,
          errorSummary: failure.summary,
          providerProcessStarted,
          providerExecution: identityExecution ?? undefined,
          db,
        });
      } else {
        const rejections =
          error instanceof XPostQualityError && error.rejections.length > 0
            ? error.rejections
            : undefined;
        await failFormalRun({
          runId: job.runId,
          failureClass: failure.failureClass,
          errorSummary: failure.summary,
          providerEvidence: scanExecution
            ? {
                provider: 'grok-build',
                operation: scanExecution.toolName,
                requestMetadataHash: scanExecution.requestMetadataHash,
                responseMetadataHash: scanExecution.responseMetadataHash,
                providerJobIdHash: scanExecution.toolCallIdHash,
                providerUnits: 1,
                terminalState:
                  failure.failureClass === 'X_ALL_POSTS_REJECTED'
                    ? 'ATTESTED_ALL_POSTS_REJECTED'
                    : 'ATTESTED_PROCESSING_FAILED',
                runMetrics: {
                  durationMs: Math.round(scanExecution.durationMs),
                  eventCount: scanExecution.eventCount,
                  inputTokens: scanExecution.inputTokens,
                  outputTokens: scanExecution.outputTokens,
                  totalCostUsd: scanExecution.totalCostUsd,
                  returned: scanExecution.posts.length,
                  ...(scanAccounting ?? {}),
                  rejected: rejections?.length ?? scanAccounting?.rejected ?? 0,
                  rawPostEvidenceAvailable: scanExecution.rawPostEvidenceAvailable,
                  traceHash: scanExecution.traceHash,
                },
              }
            : undefined,
          rejections,
          providerProcessStarted,
          db,
        });
      }
    }
    throw error;
  }
}
