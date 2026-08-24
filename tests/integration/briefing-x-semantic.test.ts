import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, ne } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import type { GrokBuildExecutionResult } from '../../src/content/acquisition/grok-build-executor';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { compileXBudgetPolicy } from '../../src/content/acquisition/x-budget';
import type { XToolRequestV1 } from '../../src/content/acquisition/x-query-compiler';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalXWorker } from '../../src/content/workers/formal-x.worker';
import {
  contentAcquisitionBudgetReservations,
  contentAcquisitionGaps,
  contentAcquisitionProviderTraces,
  contentAcquisitionRuns,
  contentSourceEndpoints,
  contentSourceObservations,
  contentSourcePartitions,
  contentSourceReceipts,
  contentSourceSchedules,
  contentSources,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';
import { resetBriefingAcquisitionState } from './helpers/briefing-acquisition-reset';

const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;

afterAll(async () => {
  await databaseSingleton.disconnect();
});

function snowflakeAt(timestamp: Date, sequence: number): string {
  return (
    ((BigInt(timestamp.getTime()) - X_SNOWFLAKE_EPOCH_MS) << 22n) |
    BigInt(sequence)
  ).toString();
}

function semanticExecution(request: XToolRequestV1): GrokBuildExecutionResult {
  if (request.toolName !== 'x_semantic_search') throw new Error('Expected semantic request');
  const knownAt = new Date(Date.now() - 2 * 60_000);
  const observedAt = new Date(Date.now() - 3 * 60_000);
  const invalidAt = new Date(Date.now() - 72 * 60 * 60_000);
  const knownId = snowflakeAt(knownAt, 1);
  const observedId = snowflakeAt(observedAt, 2);
  const invalidId = snowflakeAt(invalidAt, 3);
  return {
    toolName: 'x_semantic_search',
    toolInput: {
      query: request.query,
      from_date: request.fromDate,
      to_date: request.toDate,
      limit: request.limit,
    },
    posts: [
      {
        postId: knownId,
        authorHandle: 'OfficialFPL',
        createdAt: knownAt.toISOString(),
        text: 'Known source semantic result',
        url: `https://x.com/OfficialFPL/status/${knownId}`,
      },
      {
        postId: observedId,
        authorHandle: 'FixtureScout',
        createdAt: observedAt.toISOString(),
        text: 'Observed source semantic result',
        url: `https://x.com/FixtureScout/status/${observedId}`,
      },
      {
        postId: invalidId,
        authorHandle: 'OutsideWindow',
        createdAt: invalidAt.toISOString(),
        text: 'This result must be rejected against the immutable exact window',
        url: `https://x.com/OutsideWindow/status/${invalidId}`,
      },
    ],
    users: [],
    requestMetadataHash: 'a'.repeat(64),
    responseMetadataHash: 'b'.repeat(64),
    traceHash: 'c'.repeat(64),
    toolCallIdHash: 'd'.repeat(64),
    eventCount: 5,
    durationMs: 100,
    inputTokens: 100,
    outputTokens: 20,
    totalCostUsd: 0.01,
    rawPostEvidenceAvailable: false,
    outputContractRevision: 2,
  };
}

function allRejectedSemanticExecution(request: XToolRequestV1): GrokBuildExecutionResult {
  const result = semanticExecution(request);
  return {
    ...result,
    posts: result.posts.filter((post) => post.authorHandle === 'OutsideWindow'),
    traceHash: 'e'.repeat(64),
    toolCallIdHash: 'f'.repeat(64),
  };
}

function saturatedSemanticExecution(request: XToolRequestV1): GrokBuildExecutionResult {
  const result = semanticExecution(request);
  const posts = Array.from({ length: 10 }, (_, index) => {
    const createdAt = new Date(Date.now() - (index + 2) * 60_000);
    const postId = snowflakeAt(createdAt, index + 10);
    return {
      postId,
      authorHandle: 'OfficialFPL',
      createdAt: createdAt.toISOString(),
      text: `Bounded semantic result ${index + 1}`,
      url: `https://x.com/OfficialFPL/status/${postId}`,
    };
  });
  return {
    ...result,
    posts,
    traceHash: '1'.repeat(64),
    toolCallIdHash: '2'.repeat(64),
  };
}

test('attributes semantic posts to known sources and non-recurring observed sources', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  const budgetPolicy = compileXBudgetPolicy({
    coverage: bundle.coverage,
    globalRolling24hLimit: 2_400,
    final90Rolling90mLimit: 300,
  });
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'x-semantic-test' });
  const db = await getDb();
  const [knownEndpoint] = await db
    .select({ endpointId: contentSourceEndpoints.endpointId })
    .from(contentSourceEndpoints)
    .where(eq(contentSourceEndpoints.endpointKey, 'official-fpl-x'))
    .limit(1);
  const [partition] = await db
    .select({ partitionId: contentSourcePartitions.partitionId })
    .from(contentSourcePartitions)
    .where(eq(contentSourcePartitions.partitionKey, 'semantic-availability'))
    .limit(1);
  if (!knownEndpoint || !partition) throw new Error('Semantic fixture registry rows are missing');
  await db
    .update(contentSourceEndpoints)
    .set({
      stableExternalId: '761568335138058240',
      identityStatus: 'VERIFIED',
      identityCheckedAt: new Date(),
      identityNextCheckAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    })
    .where(eq(contentSourceEndpoints.endpointId, knownEndpoint.endpointId));
  await db
    .update(contentSourceSchedules)
    .set({ status: 'paused' })
    .where(ne(contentSourceSchedules.partitionId, partition.partitionId));
  await db
    .update(contentSourceSchedules)
    .set({
      status: 'active',
      nextDueAt: new Date(Date.now() - 60_000),
      leaseOwner: null,
      leaseExpiresAt: null,
      failureStreak: 0,
      circuitState: 'CLOSED',
      probeAfter: null,
    })
    .where(eq(contentSourceSchedules.partitionId, partition.partitionId));

  const [claimed] = await claimDueFormalRuns({
    enabledAdapters: ['X_SEMANTIC'],
    claimLimit: 1,
    xBudgetPolicy: budgetPolicy,
  });
  if (!claimed) throw new Error('Semantic run was not claimed');
  expect(claimed.jobKind).toBe('X_SEMANTIC_SCAN');
  const [claimedSnapshot] = await db
    .select({
      windowStart: contentAcquisitionRuns.windowStart,
      requestSnapshot: contentAcquisitionRuns.requestSnapshot,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, claimed.runId));
  const persistedToolRequest = (
    claimedSnapshot?.requestSnapshot as { toolRequest?: { fromDate?: string } }
  ).toolRequest;
  expect(claimedSnapshot?.windowStart?.toISOString().slice(11)).toBe('00:00:00.000Z');
  expect(persistedToolRequest?.fromDate).toBe(
    claimedSnapshot?.windowStart?.toISOString().slice(0, 10),
  );
  expect(await confirmFormalRunEnqueued({ runId: claimed.runId })).toBe(true);
  const result = await runFormalXWorker(claimed.job, {
    flags: {
      ...getContentRuntimeFlags(),
      pipelineEnabled: true,
      acquisitionShadowMode: true,
      xScanEnabled: true,
      realGrokEnabled: true,
    },
    executor: { execute: async (request) => semanticExecution(request) },
    xBudgetPolicy: budgetPolicy,
  });
  expect(result).toMatchObject({
    status: 'PARTIAL',
    receiptCount: 2,
    revisionCount: 2,
    rejectedCount: 1,
  });

  const observed = await db
    .select({
      sourceId: contentSources.sourceId,
      sourceKey: contentSources.sourceKey,
      sourceType: contentSources.sourceType,
      sourceStatus: contentSources.status,
      sourceOrigin: contentSources.origin,
      endpointId: contentSourceEndpoints.endpointId,
      endpointStatus: contentSourceEndpoints.status,
      endpointOrigin: contentSourceEndpoints.origin,
      identityStatus: contentSourceEndpoints.identityStatus,
      identityNextCheckAt: contentSourceEndpoints.identityNextCheckAt,
    })
    .from(contentSources)
    .innerJoin(contentSourceEndpoints, eq(contentSourceEndpoints.sourceId, contentSources.sourceId))
    .where(eq(contentSources.handle, 'FixtureScout'));
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({
    sourceType: 'DISCOVERED_UNKNOWN',
    sourceStatus: 'observed',
    sourceOrigin: 'DISCOVERED',
    endpointStatus: 'observed',
    endpointOrigin: 'DISCOVERED',
    identityStatus: 'PENDING',
    identityNextCheckAt: null,
  });
  const observedSchedules = await db
    .select({ scheduleId: contentSourceSchedules.scheduleId })
    .from(contentSourceSchedules)
    .where(eq(contentSourceSchedules.endpointId, observed[0]!.endpointId));
  expect(observedSchedules).toHaveLength(0);

  const receiptSources = await db
    .select({ sourceKey: contentSources.sourceKey })
    .from(contentSourceReceipts)
    .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceReceipts.sourceId))
    .where(eq(contentSourceReceipts.runId, claimed.runId));
  expect(receiptSources.map((row) => row.sourceKey).sort()).toEqual(
    [observed[0]!.sourceKey, 'official-fpl'].sort(),
  );

  const partialObservations = await db
    .select({ outcome: contentSourceObservations.outcome })
    .from(contentSourceObservations)
    .where(eq(contentSourceObservations.runId, claimed.runId));
  expect(partialObservations.map((row) => row.outcome).sort()).toEqual([
    'ACCEPTED',
    'ACCEPTED',
    'REJECTED',
  ]);

  await db
    .update(contentSourceSchedules)
    .set({
      status: 'active',
      nextDueAt: new Date(Date.now() - 60_000),
      leaseOwner: null,
      leaseExpiresAt: null,
      failureStreak: 0,
      circuitState: 'CLOSED',
      probeAfter: null,
    })
    .where(eq(contentSourceSchedules.partitionId, partition.partitionId));
  const [allRejectedRun] = await claimDueFormalRuns({
    enabledAdapters: ['X_SEMANTIC'],
    claimLimit: 1,
    xBudgetPolicy: budgetPolicy,
  });
  if (!allRejectedRun) throw new Error('All-rejected semantic run was not claimed');
  expect(await confirmFormalRunEnqueued({ runId: allRejectedRun.runId })).toBe(true);
  await expect(
    runFormalXWorker(allRejectedRun.job, {
      flags: {
        ...getContentRuntimeFlags(),
        pipelineEnabled: true,
        acquisitionShadowMode: true,
        xScanEnabled: true,
        realGrokEnabled: true,
      },
      executor: { execute: async (request) => allRejectedSemanticExecution(request) },
      xBudgetPolicy: budgetPolicy,
    }),
  ).rejects.toThrow('All 1 Grok posts failed deterministic validation');

  const [failedRun] = await db
    .select({
      status: contentAcquisitionRuns.status,
      failureClass: contentAcquisitionRuns.failureClass,
      checkpointAdvanced: contentAcquisitionRuns.checkpointAdvanced,
      provider: contentAcquisitionRuns.provider,
      providerUnits: contentAcquisitionRuns.providerUnits,
      rejectedCount: contentAcquisitionRuns.rejectedCount,
      traceVerified: contentAcquisitionRuns.traceVerified,
      xCallCount: contentAcquisitionRuns.xCallCount,
      runMetrics: contentAcquisitionRuns.runMetrics,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, allRejectedRun.runId));
  expect(failedRun).toMatchObject({
    status: 'FAILED',
    failureClass: 'X_ALL_POSTS_REJECTED',
    checkpointAdvanced: false,
    provider: 'grok-build',
    providerUnits: '1.000000',
    rejectedCount: 1,
    traceVerified: true,
    xCallCount: 1,
  });
  expect((failedRun?.runMetrics as { totalCostUsd?: number }).totalCostUsd).toBe(0.01);
  const failedTraces = await db
    .select({ terminalState: contentAcquisitionProviderTraces.terminalState })
    .from(contentAcquisitionProviderTraces)
    .where(eq(contentAcquisitionProviderTraces.runId, allRejectedRun.runId));
  expect(failedTraces).toEqual([{ terminalState: 'ATTESTED_ALL_POSTS_REJECTED' }]);
  const failedObservations = await db
    .select({
      outcome: contentSourceObservations.outcome,
      reasonCode: contentSourceObservations.reasonCode,
    })
    .from(contentSourceObservations)
    .where(eq(contentSourceObservations.runId, allRejectedRun.runId));
  expect(failedObservations).toEqual([
    { outcome: 'REJECTED', reasonCode: 'X_POST_OUTSIDE_WINDOW' },
  ]);
  const failedReservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, allRejectedRun.runId));
  expect(failedReservations.length).toBeGreaterThan(0);
  expect(failedReservations.every((reservation) => reservation.status === 'COMMITTED')).toBe(true);

  await db
    .update(contentSourceSchedules)
    .set({
      status: 'active',
      nextDueAt: new Date(Date.now() - 60_000),
      leaseOwner: null,
      leaseExpiresAt: null,
      failureStreak: 0,
      circuitState: 'CLOSED',
      probeAfter: null,
    })
    .where(eq(contentSourceSchedules.partitionId, partition.partitionId));
  const [saturatedRun] = await claimDueFormalRuns({
    enabledAdapters: ['X_SEMANTIC'],
    claimLimit: 1,
    xBudgetPolicy: budgetPolicy,
  });
  if (!saturatedRun) throw new Error('Saturated semantic run was not claimed');
  expect(await confirmFormalRunEnqueued({ runId: saturatedRun.runId })).toBe(true);
  const saturated = await runFormalXWorker(saturatedRun.job, {
    flags: {
      ...getContentRuntimeFlags(),
      pipelineEnabled: true,
      acquisitionShadowMode: true,
      xScanEnabled: true,
      realGrokEnabled: true,
    },
    executor: { execute: async (request) => saturatedSemanticExecution(request) },
    xBudgetPolicy: budgetPolicy,
  });
  expect(saturated).toMatchObject({ status: 'SATURATED', receiptCount: 10, rejectedCount: 0 });
  const semanticChildren = await db
    .select({ runId: contentAcquisitionRuns.runId })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, saturatedRun.runId));
  expect(semanticChildren).toHaveLength(0);
  const semanticGaps = await db
    .select({ reason: contentAcquisitionGaps.reason })
    .from(contentAcquisitionGaps)
    .where(eq(contentAcquisitionGaps.declaringRunId, saturatedRun.runId));
  expect(semanticGaps).toEqual([{ reason: 'SEMANTIC_RESULT_CAP' }]);

  await db
    .update(contentSourceSchedules)
    .set({
      status: 'active',
      nextDueAt: new Date(Date.now() - 60_000),
      leaseOwner: null,
      leaseExpiresAt: null,
      failureStreak: 0,
      circuitState: 'CLOSED',
      probeAfter: null,
    })
    .where(eq(contentSourceSchedules.partitionId, partition.partitionId));
  const [traceFailureRun] = await claimDueFormalRuns({
    enabledAdapters: ['X_SEMANTIC'],
    claimLimit: 1,
    xBudgetPolicy: budgetPolicy,
  });
  if (!traceFailureRun) throw new Error('Trace-failure semantic run was not claimed');
  expect(await confirmFormalRunEnqueued({ runId: traceFailureRun.runId })).toBe(true);
  await expect(
    runFormalXWorker(traceFailureRun.job, {
      flags: {
        ...getContentRuntimeFlags(),
        pipelineEnabled: true,
        acquisitionShadowMode: true,
        xScanEnabled: true,
        realGrokEnabled: true,
      },
      executor: {
        execute: async (_request, hooks) => {
          hooks?.onProviderProcessStart?.();
          throw new Error('Synthetic malformed trace after provider process launch');
        },
      },
      xBudgetPolicy: budgetPolicy,
    }),
  ).rejects.toThrow('Synthetic malformed trace');
  const [traceFailure] = await db
    .select({
      status: contentAcquisitionRuns.status,
      provider: contentAcquisitionRuns.provider,
      providerUnits: contentAcquisitionRuns.providerUnits,
      xCallCount: contentAcquisitionRuns.xCallCount,
      traceVerified: contentAcquisitionRuns.traceVerified,
      runMetrics: contentAcquisitionRuns.runMetrics,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, traceFailureRun.runId));
  expect(traceFailure).toMatchObject({
    status: 'FAILED',
    provider: 'grok-build',
    providerUnits: '1.000000',
    xCallCount: 1,
    traceVerified: false,
    runMetrics: { providerProcessStarted: true, providerTraceVerified: false },
  });
  const traceFailureReservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, traceFailureRun.runId));
  expect(traceFailureReservations.length).toBeGreaterThan(0);
  expect(traceFailureReservations.every((reservation) => reservation.status === 'COMMITTED')).toBe(
    true,
  );
  const unattestedTraces = await db
    .select({ traceId: contentAcquisitionProviderTraces.traceId })
    .from(contentAcquisitionProviderTraces)
    .where(eq(contentAcquisitionProviderTraces.runId, traceFailureRun.runId));
  expect(unattestedTraces).toEqual([]);
});
