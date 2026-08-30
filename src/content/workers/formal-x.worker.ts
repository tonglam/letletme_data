import { sql } from 'drizzle-orm';

import {
  getAcquisitionProfile,
  X_ACQUISITION_LANES,
  type XAcquisitionLane,
} from '../acquisition/acquisition-profiles';
import { sha256CanonicalJson } from '../acquisition/canonicalization';
import {
  acquisitionJobV1Schema,
  type AcquisitionJobV1,
  type XScanRunRequestV1,
} from '../acquisition/formal-run-contract';
import {
  beginFormalRun,
  deferFormalRunForCapacity,
  failFormalRun,
  type FormalRunProviderEvidence,
  type FormalRunProbeEvidence,
} from '../acquisition/formal-run-repository';
import {
  GrokBuildExecutionError,
  type GrokBuildFailureEvidence,
  type GrokBuildExecutionResult,
  type GrokBuildExecutionHooks,
} from '../acquisition/grok-build-executor';
import { persistAcquisitionResult } from '../acquisition/receipt-repository';
import { resolveSemanticXAuthors } from '../acquisition/semantic-author-resolver';
import {
  adaptGrokBuildPosts,
  adaptGrokBuildSemanticPosts,
  adaptTikHubTimelinePosts,
  prevalidateGrokBuildPostsForAuthorResolution,
  XPostQualityError,
} from '../acquisition/x-post-adapter';
import {
  TikHubXTimelineError,
  type TikHubXFailureEvidence,
  type TikHubXTimelineExecutionResult,
  type TikHubXExecutionHooks,
} from '../acquisition/tikhub-x-timeline-client';
import { failXIdentityRun, persistXIdentityResult } from '../acquisition/x-identity-repository';
import {
  releaseOneXRunBudgetUnit,
  reserveXRunBudgets,
  type XBudgetLane,
  type XBudgetPolicy,
} from '../acquisition/x-budget';
import { compileXKeywordRequest, compileXUserRequest } from '../acquisition/x-query-compiler';
import type { XToolRequestV1 } from '../acquisition/x-query-compiler';
import { nextBackstopDueAt } from '../acquisition/registry-state';
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
    | 'BUDGET_DEFERRED'
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
    request: XToolRequestV1,
    hooks?: GrokBuildExecutionHooks,
  ) => Promise<GrokBuildExecutionResult>;
}>;

export type TikHubXTimelineExecutorLike = Readonly<{
  execute: (
    request: XScanRunRequestV1,
    hooks?: TikHubXExecutionHooks,
  ) => Promise<TikHubXTimelineExecutionResult>;
}>;

function errorFacts(error: unknown): {
  failureClass: string;
  summary: string;
  evidence: GrokBuildFailureEvidence | TikHubXFailureEvidence | null;
} {
  const candidate = error as {
    failureClass?: unknown;
    message?: unknown;
    evidence?: GrokBuildFailureEvidence | TikHubXFailureEvidence | null;
  };
  return {
    failureClass:
      typeof candidate?.failureClass === 'string' ? candidate.failureClass : 'X_ADAPTER_FAILED',
    summary: typeof candidate?.message === 'string' ? candidate.message : 'Formal X adapter failed',
    evidence: candidate.evidence ?? null,
  };
}

const HOST_X_PROBE_REQUEST_METADATA_HASH = sha256CanonicalJson({
  toolName: compileXUserRequest('OfficialFPL').toolName,
  input: { query: 'OfficialFPL', count: 3 },
});

function hostXProbeEvidence(terminalState: string): FormalRunProbeEvidence {
  return {
    provider: 'grok-build',
    operation: 'x_user_search',
    requestMetadataHash: HOST_X_PROBE_REQUEST_METADATA_HASH,
    responseMetadataHash: null,
    providerJobIdHash: null,
    providerUnits: 1,
    terminalState,
    runMetrics: {
      controlPlaneProbe: true,
      probeTarget: 'OfficialFPL',
    },
  };
}

function failureProviderEvidence(
  request: XToolRequestV1,
  evidence: GrokBuildFailureEvidence,
): FormalRunProviderEvidence {
  const input: Record<string, string | number> =
    request.toolName === 'x_keyword_search'
      ? { query: request.query, limit: request.limit, mode: request.mode }
      : request.toolName === 'x_semantic_search'
        ? {
            query: request.query,
            from_date: request.fromDate,
            to_date: request.toDate,
            limit: request.limit,
          }
        : request.toolName === 'x_user_search'
          ? { query: request.handle, count: 3 }
          : { post_id: request.postId };
  return {
    provider: 'grok-build',
    operation: request.toolName,
    requestMetadataHash: sha256CanonicalJson({ toolName: request.toolName, input }),
    responseMetadataHash: evidence.responseMetadataHash,
    providerJobIdHash: evidence.toolCallIdHash,
    providerUnits: 1,
    terminalState: `ATTESTED_${evidence.failureStage}_REJECTED`,
    runMetrics: {
      failureStage: evidence.failureStage,
      outputContractRevision: evidence.outputContractRevision,
      responseBytes: evidence.responseBytes,
      traceHash: evidence.traceHash,
      eventCount: evidence.eventCount,
      durationMs: Math.round(evidence.durationMs),
      inputTokens: evidence.inputTokens,
      outputTokens: evidence.outputTokens,
      totalCostUsd: evidence.totalCostUsd,
      issueCodes: evidence.issueCodes,
      issuePaths: evidence.issuePaths,
      schemaFingerprint: evidence.schemaFingerprint,
      ignoredOutputKeyCount: evidence.ignoredOutputKeyCount,
      ignoredOutputKeysHash: evidence.ignoredOutputKeysHash,
      rawPostEvidenceAvailable: evidence.rawPostEvidenceAvailable,
      runnerReleaseSha: evidence.runnerReleaseSha,
      grokVersion: evidence.grokVersion,
      runnerBinaryHash: evidence.runnerBinaryHash,
    },
  };
}

function tikhubFailureProviderEvidence(
  evidence: TikHubXFailureEvidence,
  failureClass: string,
): FormalRunProviderEvidence {
  return {
    provider: 'tikhub',
    operation: evidence.operation,
    requestMetadataHash: evidence.requestMetadataHash,
    responseMetadataHash: evidence.responseMetadataHash,
    providerJobIdHash: evidence.providerJobIdHash,
    providerUnits: evidence.providerUnits,
    terminalState: `FAILED:${failureClass}`.slice(0, 200),
    runMetrics: {
      durationMs: Math.round(evidence.durationMs),
      responseBytes: evidence.responseBytes,
      httpStatus: evidence.httpStatus,
      estimatedCostUsd: evidence.estimatedCostUsd,
      pricingRevision: evidence.pricingRevision,
      providerRoute: 'TIKHUB_TIMELINE',
    },
  };
}

function tikhubExecutionProviderEvidence(
  execution: TikHubXTimelineExecutionResult,
  terminalState: string,
): FormalRunProviderEvidence {
  return {
    provider: 'tikhub',
    operation: execution.operation,
    requestMetadataHash: execution.requestMetadataHash,
    responseMetadataHash: execution.responseMetadataHash,
    providerJobIdHash: execution.providerJobIdHash,
    providerUnits: execution.providerUnits,
    terminalState,
    runMetrics: {
      durationMs: Math.round(execution.durationMs),
      responseBytes: execution.responseBytes,
      rawReturned: execution.rawReturnedCount,
      excludedRetweets: execution.excludedRetweets,
      excludedOutsideWindow: execution.excludedOutsideWindow,
      duplicatePosts: execution.duplicatePosts,
      estimatedCostUsd: execution.estimatedCostUsd,
      pricingRevision: execution.pricingRevision,
      memberMetrics: execution.memberMetrics,
      providerRoute: 'TIKHUB_TIMELINE',
    },
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
    tikhubExecutor?: TikHubXTimelineExecutorLike;
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
  let probeReservationIds: readonly string[] | null = null;
  let probeIncrementedReservationIds: readonly string[] = [];
  let probeProcessStarted = false;
  let probeCompletedSuccessfully = false;
  let releaseProbeBudget: (() => Promise<void>) | null = null;
  let identityExecution: GrokBuildExecutionResult | null = null;
  let scanExecution: GrokBuildExecutionResult | null = null;
  let tikhubExecution: TikHubXTimelineExecutionResult | null = null;
  let activeRun: Awaited<ReturnType<typeof beginFormalRun>> | null = null;
  let scanAccounting: Readonly<{
    returned: number;
    accepted: number;
    rejected: number;
    saturated: boolean;
  }> | null = null;
  try {
    const run = await beginFormalRun({ runId: job.runId, db });
    activeRun = run;
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
      run.request.jobKind !== 'X_SEMANTIC_SCAN' &&
      run.request.jobKind !== 'X_THREAD_FETCH'
    ) {
      throw new Error(`X worker cannot execute ${run.request.jobKind}`);
    }
    const profile = getAcquisitionProfile(run.request.profileKey);
    if (!profile || profile.revision !== run.request.profileRevision) {
      throw new Error('Persisted X profile no longer matches versioned code');
    }
    const budgetLane: XBudgetLane = identityRun ? 'IDENTITY' : (profile.lane as XAcquisitionLane);
    if (!identityRun && !X_ACQUISITION_LANES.includes(budgetLane as XAcquisitionLane)) {
      throw new Error('Persisted X profile has no valid budget lane');
    }
    const reserveProbeBudget = async (): Promise<void> => {
      if (probeReservationIds !== null) return;
      if (!dependencies?.xBudgetPolicy) {
        throw new GrokBuildExecutionError(
          'RUNNER_CAPACITY',
          'X probe requires an explicit budget policy',
        );
      }
      const budget = await db.transaction(async (tx) => {
        const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
        const dbNow = new Date(clockRows[0]?.dbNow ?? Number.NaN);
        if (!Number.isFinite(dbNow.getTime())) throw new Error('Database clock is invalid');
        return reserveXRunBudgets({
          tx,
          runId: job.runId,
          phase: run.request.phase,
          lane: budgetLane,
          dbNow,
          policy: dependencies.xBudgetPolicy!,
          units: 1,
          separateReservation: true,
        });
      });
      if (!budget.reserved) {
        throw new GrokBuildExecutionError(
          'RUNNER_CAPACITY',
          `X probe budget is unavailable (${budget.deferredScope ?? 'unknown scope'})`,
        );
      }
      probeReservationIds = budget.reservationIds;
      probeIncrementedReservationIds = budget.incrementedReservationIds;
    };
    const executionHooks: GrokBuildExecutionHooks = {
      runId: job.runId,
      onProviderProcessStart: () => {
        providerProcessStarted = true;
      },
      onProbeRequest: reserveProbeBudget,
      onProbeProcessStart: () => {
        probeProcessStarted = true;
      },
      onProbeCompleted: () => {
        probeCompletedSuccessfully = true;
      },
    };
    releaseProbeBudget = async (): Promise<void> => {
      if (probeReservationIds === null) return;
      const reservationIds = probeReservationIds;
      await db.transaction(async (tx) => {
        const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
        const dbNow = new Date(clockRows[0]?.dbNow ?? Number.NaN);
        if (!Number.isFinite(dbNow.getTime())) throw new Error('Database clock is invalid');
        const released = await releaseOneXRunBudgetUnit({
          tx,
          runId: job.runId,
          dbNow,
          reservationIds,
        });
        if (!released) throw new Error('X probe budget reservation disappeared before release');
      });
      probeReservationIds = null;
    };
    const reserveAdditionalXCallBudget = async (callIndex: number): Promise<void> => {
      // The recurring scheduler already reserved the first provider call.
      if (callIndex === 0) return;
      if (!dependencies?.xBudgetPolicy) {
        throw new TikHubXTimelineError(
          'TIKHUB_BUDGET_UNAVAILABLE',
          'TikHub pagination requires an explicit X budget policy',
        );
      }
      const budget = await db.transaction(async (tx) => {
        const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
        const dbNow = new Date(clockRows[0]?.dbNow ?? Number.NaN);
        if (!Number.isFinite(dbNow.getTime())) throw new Error('Database clock is invalid');
        return reserveXRunBudgets({
          tx,
          runId: job.runId,
          phase: run.request.phase,
          lane: budgetLane,
          dbNow,
          policy: dependencies.xBudgetPolicy!,
          units: 1,
        });
      });
      if (!budget.reserved) {
        throw new TikHubXTimelineError(
          'TIKHUB_BUDGET_UNAVAILABLE',
          `TikHub pagination budget is unavailable (${budget.deferredScope ?? 'unknown scope'})`,
        );
      }
    };
    if (run.request.jobKind === 'X_IDENTITY') {
      const executor = dependencies?.executor;
      if (!executor) throw new Error('Host Grok runner executor is not configured');
      const execution = await executor.execute(run.request.toolRequest, executionHooks);
      identityExecution = execution;
      const identity = await persistXIdentityResult({
        runId: job.runId,
        execution,
        probeEvidence: probeProcessStarted ? hostXProbeEvidence('CONTROL_PLANE_PROBE') : undefined,
        db,
      });
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
        scanRequest.toolRequest.toolName !== 'x_semantic_search') ||
      (scanRequest.jobKind === 'X_THREAD_FETCH' &&
        scanRequest.toolRequest.toolName !== 'x_thread_fetch')
    ) {
      throw new Error('Persisted X scan job and tool request do not agree');
    }
    const providerTraceStart = run.providerTraceSequence;
    let semanticAuthors: Awaited<ReturnType<typeof resolveSemanticXAuthors>> | null = null;
    let adapted: ReturnType<typeof adaptGrokBuildPosts>;
    let providerTraces: Array<{
      sequence: number;
      provider: string;
      operation: string;
      requestMetadataHash: string;
      responseMetadataHash: string | null;
      providerJobIdHash: string | null;
      providerUnits: number;
      terminalState: string;
    }>;
    let providerResult: { provider: string; providerUnits: number };
    let providerRunMetrics: Readonly<Record<string, unknown>>;
    if (scanRequest.providerRoute === 'TIKHUB_TIMELINE') {
      const tikhubExecutor = dependencies?.tikhubExecutor;
      if (!tikhubExecutor) {
        throw new TikHubXTimelineError(
          'TIKHUB_DISABLED',
          'TikHub timeline executor is not configured',
        );
      }
      const execution = await tikhubExecutor.execute(scanRequest, {
        beforeProviderCall: reserveAdditionalXCallBudget,
        onProviderCallStart: () => {
          providerProcessStarted = true;
        },
      });
      tikhubExecution = execution;
      const checkedAt = await databaseNow(db);
      adapted = adaptTikHubTimelinePosts({ request: scanRequest, execution, checkedAt });
      providerTraces = [
        {
          sequence: providerTraceStart,
          provider: 'tikhub',
          operation: execution.operation,
          requestMetadataHash: execution.requestMetadataHash,
          responseMetadataHash: execution.responseMetadataHash,
          providerJobIdHash: execution.providerJobIdHash,
          providerUnits: execution.providerUnits,
          terminalState: 'HTTP_VALIDATED',
        },
      ];
      providerResult = {
        provider: 'tikhub',
        providerUnits: run.providerUnits + execution.providerUnits,
      };
      providerRunMetrics = {
        durationMs: Math.round(execution.durationMs),
        providerRoute: scanRequest.providerRoute,
        providerCalls: execution.providerUnits,
        responseBytes: execution.responseBytes,
        rawReturned: execution.rawReturnedCount,
        excludedRetweets: execution.excludedRetweets,
        excludedOutsideWindow: execution.excludedOutsideWindow,
        duplicatePosts: execution.duplicatePosts,
        estimatedCostUsd: execution.estimatedCostUsd,
        pricingRevision: execution.pricingRevision,
        memberMetrics: execution.memberMetrics,
      };
    } else {
      const executor = dependencies?.executor;
      if (!executor) throw new Error('Host Grok runner executor is not configured');
      const execution = await executor.execute(scanRequest.toolRequest, executionHooks);
      scanExecution = execution;
      const checkedAt = await databaseNow(db);
      semanticAuthors =
        scanRequest.jobKind === 'X_SEMANTIC_SCAN'
          ? await resolveSemanticXAuthors({
              posts: prevalidateGrokBuildPostsForAuthorResolution({
                request: scanRequest,
                execution,
              }),
              db,
            })
          : null;
      adapted = semanticAuthors
        ? adaptGrokBuildSemanticPosts({
            request: scanRequest,
            execution,
            checkedAt,
            authors: semanticAuthors,
          })
        : adaptGrokBuildPosts({
            request: scanRequest,
            execution,
            checkedAt,
          });
      providerTraces = [
        ...(probeProcessStarted
          ? [
              {
                sequence: providerTraceStart,
                provider: 'grok-build',
                operation: 'x_user_search',
                requestMetadataHash: HOST_X_PROBE_REQUEST_METADATA_HASH,
                responseMetadataHash: null,
                providerJobIdHash: null,
                providerUnits: 1,
                terminalState: 'CONTROL_PLANE_PROBE',
              },
            ]
          : []),
        {
          sequence: providerTraceStart + (probeProcessStarted ? 1 : 0),
          provider: 'grok-build',
          operation: execution.toolName,
          requestMetadataHash: execution.requestMetadataHash,
          responseMetadataHash: execution.responseMetadataHash,
          providerJobIdHash: execution.toolCallIdHash,
          providerUnits: 1,
          terminalState: 'ATTESTED_FINAL',
        },
      ];
      providerResult = {
        provider: 'grok-build',
        providerUnits: run.providerUnits + 1 + (probeProcessStarted ? 1 : 0),
      };
      providerRunMetrics = {
        durationMs: Math.round(execution.durationMs),
        eventCount: execution.eventCount,
        inputTokens: execution.inputTokens,
        outputTokens: execution.outputTokens,
        totalCostUsd: execution.totalCostUsd,
        executionLocation: execution.executionLocation,
        runnerReleaseSha: execution.runnerReleaseSha,
        grokVersion: execution.grokVersion,
        runnerBinaryHash: execution.runnerBinaryHash,
        probeCallCount: probeProcessStarted ? 1 : 0,
        rawPostEvidenceAvailable: execution.rawPostEvidenceAvailable,
        traceHash: execution.traceHash,
        outputContractRevision: execution.outputContractRevision,
        ignoredOutputKeyCount: execution.ignoredOutputKeyCount,
        ignoredOutputKeysHash: execution.ignoredOutputKeysHash,
        providerRoute: scanRequest.providerRoute,
      };
    }
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
    if (adapted.saturated && scanRequest.providerRoute === 'TIKHUB_TIMELINE') {
      state = 'GAP';
      acquisitionGap = {
        windowStart: scanRequest.windowStart,
        windowEnd: scanRequest.windowEnd,
        reason: 'TIKHUB_TIMELINE_PAGE_CAP',
        detailsHash: sha256CanonicalJson({
          providerUnits: tikhubExecution?.providerUnits ?? 0,
          memberMetrics: [...(tikhubExecution?.memberMetrics ?? [])],
        }),
      };
    } else if (adapted.saturated && scanRequest.jobKind === 'X_SEMANTIC_SCAN') {
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
      scanRequest.providerRoute === 'GROK_BUILD' &&
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
    const checkpointComplete =
      run.scheduleId !== null &&
      state !== 'PARTIAL' &&
      (state !== 'GAP' || scanRequest.providerRoute === 'TIKHUB_TIMELINE');
    const completedAt = await databaseNow(db);
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
            checkedAt: completedAt.toISOString(),
            windowEnd: scanRequest.windowEnd,
            newestPostId: adapted.newestPostId,
          }
        : undefined,
      nextDueAt:
        run.scheduleId === null
          ? undefined
          : scanRequest.coverageMode === 'BACKSTOP'
            ? nextBackstopDueAt(completedAt, run.scheduleKey ?? run.scheduleId)
            : new Date(completedAt.getTime() + profile.cadenceMinutes[run.request.phase] * 60_000),
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
      providerTraces,
      providerResult,
      runMetrics: {
        ...providerRunMetrics,
        returned: adapted.returnedCount,
        accepted: adapted.acceptedCount,
        rejected: adapted.rejections.length,
        saturated: adapted.saturated,
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
      // The control-plane probe and the requested scan are separate billable
      // operations. A successful probe followed by a pre-dispatch scan
      // failure must commit only the probe unit and release the scan unit.
      const mainProviderProcessStarted = providerProcessStarted;
      const probeOnly = probeProcessStarted && !mainProviderProcessStarted;
      const probeEvidence = probeProcessStarted
        ? hostXProbeEvidence(
            probeCompletedSuccessfully ? 'CONTROL_PLANE_PROBE' : 'CONTROL_PLANE_PROBE_FAILED',
          )
        : undefined;
      const transientPreProviderFailure = [
        'RUNNER_CAPACITY',
        'RUNNER_UNAVAILABLE',
        'RUNNER_TIMEOUT',
        'RUNNER_NOT_READY',
      ].includes(failure.failureClass);
      if (transientPreProviderFailure && !mainProviderProcessStarted) {
        if (!probeOnly) {
          await releaseProbeBudget?.();
        }
        const deferred = await deferFormalRunForCapacity({
          runId: job.runId,
          metrics: { failureClass: failure.failureClass },
          failureClass: failure.failureClass,
          probeEvidence,
          probeReservationIds: probeOnly ? (probeReservationIds ?? undefined) : undefined,
          db,
        });
        if (deferred) {
          return {
            runId: job.runId,
            status: 'BUDGET_DEFERRED',
            receiptCount: 0,
            revisionCount: 0,
            outboxCount: 0,
            returnedCount: 0,
            rejectedCount: 0,
          };
        }
      }
      if (identityRun) {
        await failXIdentityRun({
          runId: job.runId,
          failureClass: failure.failureClass,
          errorSummary: failure.summary,
          providerProcessStarted: mainProviderProcessStarted,
          providerExecution: identityExecution ?? undefined,
          probeEvidence,
          releaseExecutionBudgetAfterProbe: probeOnly,
          probeReservationIds: probeOnly ? (probeReservationIds ?? undefined) : undefined,
          probeIncrementedReservationIds: probeOnly ? probeIncrementedReservationIds : undefined,
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
          outputContractFailure: ['GROK_FINAL_INVALID', 'GROK_FINAL_SCHEMA_INVALID'].includes(
            failure.failureClass,
          ),
          providerEvidence: tikhubExecution
            ? tikhubExecutionProviderEvidence(
                tikhubExecution,
                failure.failureClass === 'X_ALL_POSTS_REJECTED'
                  ? 'HTTP_ALL_POSTS_REJECTED'
                  : 'HTTP_PROCESSING_FAILED',
              )
            : scanExecution
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
                    executionLocation: scanExecution.executionLocation,
                    runnerReleaseSha: scanExecution.runnerReleaseSha,
                    grokVersion: scanExecution.grokVersion,
                    runnerBinaryHash: scanExecution.runnerBinaryHash,
                    returned: scanExecution.posts.length,
                    ...(scanAccounting ?? {}),
                    rejected: rejections?.length ?? scanAccounting?.rejected ?? 0,
                    probeCallCount: probeProcessStarted ? 1 : 0,
                    rawPostEvidenceAvailable: scanExecution.rawPostEvidenceAvailable,
                    traceHash: scanExecution.traceHash,
                  },
                }
              : failure.evidence &&
                  activeRun &&
                  activeRun.request.jobKind !== 'X_IDENTITY' &&
                  'toolRequest' in activeRun.request
                ? 'provider' in failure.evidence && failure.evidence.provider === 'tikhub'
                  ? tikhubFailureProviderEvidence(failure.evidence, failure.failureClass)
                  : failureProviderEvidence(
                      activeRun.request.toolRequest,
                      failure.evidence as GrokBuildFailureEvidence,
                    )
                : undefined,
          rejections,
          providerProcessStarted: mainProviderProcessStarted,
          probeEvidence,
          releaseExecutionBudgetAfterProbe: probeOnly,
          probeReservationIds: probeOnly ? (probeReservationIds ?? undefined) : undefined,
          probeIncrementedReservationIds: probeOnly ? probeIncrementedReservationIds : undefined,
          db,
        });
      }
    }
    throw error;
  }
}
