import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, ne } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  beginFormalRun,
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
  failFormalRun,
} from '../../src/content/acquisition/formal-run-repository';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { compileXBudgetPolicy } from '../../src/content/acquisition/x-budget';
import {
  GrokBuildExecutionError,
  type GrokBuildExecutionResult,
  type GrokBuildXPostV1,
} from '../../src/content/acquisition/grok-build-executor';
import type { XToolRequestV1 } from '../../src/content/acquisition/x-query-compiler';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalXWorker } from '../../src/content/workers/formal-x.worker';
import {
  contentAcquisitionBudgetReservations,
  contentAcquisitionGaps,
  contentAcquisitionJobOutbox,
  contentAcquisitionRuns,
  contentSourceEndpoints,
  contentSourcePartitions,
  contentSourceSchedules,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';
import { resetBriefingAcquisitionState } from './helpers/briefing-acquisition-reset';

const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;

afterAll(async () => {
  await databaseSingleton.disconnect();
});

function timestampFromQuery(query: string, operator: 'since' | 'until'): Date {
  const match = query.match(
    new RegExp(`${operator}:(\\d{4}-\\d{2}-\\d{2})_(\\d{2}:\\d{2}:\\d{2})_UTC`),
  );
  if (!match) throw new Error(`Missing ${operator} timestamp in test query`);
  return new Date(`${match[1]}T${match[2]}Z`);
}

function snowflakeAt(timestamp: Date, sequence: number): string {
  return (
    ((BigInt(timestamp.getTime()) - X_SNOWFLAKE_EPOCH_MS) << 22n) |
    BigInt(sequence)
  ).toString();
}

function saturatedExecution(request: XToolRequestV1): GrokBuildExecutionResult {
  if (request.toolName !== 'x_keyword_search') {
    throw new Error('Saturation fixture expects x_keyword_search');
  }
  const windowStart = timestampFromQuery(request.query, 'since');
  const windowEnd = timestampFromQuery(request.query, 'until');
  if (windowEnd.getTime() - windowStart.getTime() < 20_000) {
    throw new Error('Saturation fixture requires at least a twenty-second window');
  }
  const posts: GrokBuildXPostV1[] = Array.from({ length: request.limit }, (_, index) => {
    const createdAt = new Date(windowEnd.getTime() - (index + 1) * 1_000);
    const postId = snowflakeAt(createdAt, index + 1);
    return {
      postId,
      authorHandle: 'OfficialFPL',
      createdAt: createdAt.toISOString(),
      text: `Deterministic saturation post ${postId}`,
      url: `https://x.com/OfficialFPL/status/${postId}`,
    };
  });
  return {
    toolName: 'x_keyword_search',
    toolInput: request,
    posts,
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
  };
}

test('creates one bounded saturation follow-up and turns a second saturation into a GAP', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  const budgetPolicy = compileXBudgetPolicy({
    coverage: bundle.coverage,
    globalRolling24hLimit: 2_400,
    final90Rolling90mLimit: 300,
  });
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'x-saturation-test' });
  const db = await getDb();
  const [endpoint] = await db
    .select({ endpointId: contentSourceEndpoints.endpointId })
    .from(contentSourceEndpoints)
    .where(eq(contentSourceEndpoints.endpointKey, 'official-fpl-x'))
    .limit(1);
  const [partition] = await db
    .select({ partitionId: contentSourcePartitions.partitionId })
    .from(contentSourcePartitions)
    .where(eq(contentSourcePartitions.partitionKey, 'official-fpl'))
    .limit(1);
  if (!endpoint || !partition) throw new Error('OfficialFPL manifest rows are missing');

  await db
    .update(contentSourceEndpoints)
    .set({
      stableExternalId: '761568335138058240',
      identityStatus: 'VERIFIED',
      identityCheckedAt: new Date(),
      identityNextCheckAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    })
    .where(eq(contentSourceEndpoints.endpointId, endpoint.endpointId));
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
    })
    .where(eq(contentSourceSchedules.partitionId, partition.partitionId));

  const [claimed] = await claimDueFormalRuns({
    enabledAdapters: ['X_ACCOUNT'],
    claimLimit: 1,
    xBudgetPolicy: budgetPolicy,
  });
  if (!claimed) throw new Error('OfficialFPL recurring run was not claimed');
  expect(await confirmFormalRunEnqueued({ runId: claimed.runId })).toBe(true);

  const flags = {
    ...getContentRuntimeFlags(),
    pipelineEnabled: true,
    acquisitionShadowMode: true,
    xScanEnabled: true,
    realGrokEnabled: true,
  };
  const executor = { execute: async (request: XToolRequestV1) => saturatedExecution(request) };
  const main = await runFormalXWorker(claimed.job, {
    flags,
    executor,
    xBudgetPolicy: budgetPolicy,
  });
  expect(main.status).toBe('SATURATED');
  expect(main.receiptCount).toBe(10);

  const childRuns = await db
    .select({
      runId: contentAcquisitionRuns.runId,
      status: contentAcquisitionRuns.status,
      parentRunId: contentAcquisitionRuns.parentRunId,
      scheduleId: contentAcquisitionRuns.scheduleId,
      windowStart: contentAcquisitionRuns.windowStart,
      windowEnd: contentAcquisitionRuns.windowEnd,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, claimed.runId));
  expect(childRuns).toHaveLength(1);
  const child = childRuns[0]!;
  expect(child.status).toBe('PENDING');
  expect(child.scheduleId).toBeNull();
  expect(child.windowStart).not.toBeNull();
  expect(child.windowEnd).not.toBeNull();
  const childJobs = await db
    .select({ queueName: contentAcquisitionJobOutbox.queueName })
    .from(contentAcquisitionJobOutbox)
    .where(eq(contentAcquisitionJobOutbox.runId, child.runId));
  expect(childJobs).toEqual([{ queueName: 'content-x-scan' }]);
  const childReservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, child.runId));
  expect(childReservations.length).toBeGreaterThanOrEqual(2);
  expect(childReservations.every((reservation) => reservation.status === 'RESERVED')).toBe(true);

  const probeRejected = await runFormalXWorker(
    { schemaVersion: 1, runId: child.runId },
    {
      flags,
      executor: {
        execute: async (_request, hooks) => {
          await hooks?.onProbeRequest?.();
          throw new GrokBuildExecutionError(
            'RUNNER_NOT_READY',
            'synthetic readiness probe rejection before provider start',
          );
        },
      },
      xBudgetPolicy: budgetPolicy,
    },
  );
  expect(probeRejected.status).toBe('BUDGET_DEFERRED');
  const probeRejectedReservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, child.runId));
  expect(probeRejectedReservations.some((reservation) => reservation.status === 'RELEASED')).toBe(
    true,
  );
  expect(probeRejectedReservations.some((reservation) => reservation.status === 'RESERVED')).toBe(
    true,
  );

  const capacityDeferred = await runFormalXWorker(
    { schemaVersion: 1, runId: child.runId },
    {
      flags,
      executor: {
        execute: async () => {
          throw new GrokBuildExecutionError(
            'RUNNER_CAPACITY',
            'synthetic host runner capacity exhaustion',
          );
        },
      },
      xBudgetPolicy: budgetPolicy,
    },
  );
  expect(capacityDeferred.status).toBe('BUDGET_DEFERRED');
  const [requeuedChild] = await db
    .select({
      status: contentAcquisitionRuns.status,
      completedAt: contentAcquisitionRuns.completedAt,
      leaseExpiresAt: contentAcquisitionRuns.leaseExpiresAt,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, child.runId));
  expect(requeuedChild).toMatchObject({
    status: 'PENDING',
    completedAt: null,
  });
  expect(requeuedChild?.leaseExpiresAt).not.toBeNull();
  expect(requeuedChild?.leaseExpiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
  const [requeuedJob] = await db
    .select({
      deliveredAt: contentAcquisitionJobOutbox.deliveredAt,
      availableAt: contentAcquisitionJobOutbox.availableAt,
    })
    .from(contentAcquisitionJobOutbox)
    .where(eq(contentAcquisitionJobOutbox.runId, child.runId));
  expect(requeuedJob?.deliveredAt).toBeNull();
  expect(requeuedJob?.availableAt.getTime()).toBeGreaterThan(Date.now() - 1_000);
  const requeuedReservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, child.runId));
  expect(requeuedReservations.some((reservation) => reservation.status === 'RELEASED')).toBe(true);
  expect(
    requeuedReservations
      .filter((reservation) => reservation.status !== 'RELEASED')
      .every((reservation) => reservation.status === 'RESERVED'),
  ).toBe(true);

  const followUp = await runFormalXWorker(
    { schemaVersion: 1, runId: child.runId },
    { flags, executor, xBudgetPolicy: budgetPolicy },
  );
  expect(followUp.status).toBe('GAP');
  expect(followUp.receiptCount).toBe(10);

  const grandchildren = await db
    .select({ runId: contentAcquisitionRuns.runId })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, child.runId));
  expect(grandchildren).toHaveLength(0);
  const gaps = await db
    .select({ reason: contentAcquisitionGaps.reason })
    .from(contentAcquisitionGaps)
    .where(eq(contentAcquisitionGaps.declaringRunId, child.runId));
  expect(gaps).toEqual([{ reason: 'SATURATION_FOLLOWUP_LIMIT' }]);
  const committedChildReservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, child.runId));
  expect(committedChildReservations.some((reservation) => reservation.status === 'RELEASED')).toBe(
    true,
  );
  expect(
    committedChildReservations
      .filter((reservation) => reservation.status !== 'RELEASED')
      .every((reservation) => reservation.status === 'COMMITTED'),
  ).toBe(true);

  await db
    .update(contentSourceSchedules)
    .set({ nextDueAt: new Date(Date.now() - 1_000) })
    .where(eq(contentSourceSchedules.partitionId, partition.partitionId));
  let failedRequestHash: string | null = null;
  let exhaustedRunId: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const [failureRun] = await claimDueFormalRuns({
      enabledAdapters: ['X_ACCOUNT'],
      claimLimit: 1,
      xBudgetPolicy: budgetPolicy,
    });
    if (!failureRun) throw new Error(`X retry attempt ${attempt} was not claimed`);
    failedRequestHash ??= failureRun.requestHash;
    expect(failureRun.requestHash).toBe(failedRequestHash);
    const begunFailure = await beginFormalRun({ runId: failureRun.runId });
    expect(begunFailure.status).toBe('RUNNING');
    expect(
      await failFormalRun({
        runId: failureRun.runId,
        failureClass: 'CONTROLLED_X_RETRY_FAILURE',
        errorSummary: `controlled X retry failure ${attempt}`,
      }),
    ).toBe(true);
    exhaustedRunId = failureRun.runId;
    if (attempt < 3) {
      await db
        .update(contentSourceSchedules)
        .set({ nextDueAt: new Date(Date.now() - 1_000) })
        .where(eq(contentSourceSchedules.partitionId, partition.partitionId));
    }
  }
  const [exhaustedRun] = await db
    .select({
      status: contentAcquisitionRuns.status,
      checkpointAdvanced: contentAcquisitionRuns.checkpointAdvanced,
      windowEnd: contentAcquisitionRuns.windowEnd,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, exhaustedRunId!));
  expect(exhaustedRun?.status).toBe('GAP');
  expect(exhaustedRun?.checkpointAdvanced).toBe(true);
  const retryGaps = await db
    .select({ reason: contentAcquisitionGaps.reason })
    .from(contentAcquisitionGaps)
    .where(eq(contentAcquisitionGaps.declaringRunId, exhaustedRunId!));
  expect(retryGaps).toEqual([{ reason: 'RETRY_EXHAUSTED' }]);
  const [exhaustedSchedule] = await db
    .select({
      checkpoint: contentSourceSchedules.checkpoint,
      circuitState: contentSourceSchedules.circuitState,
      failureStreak: contentSourceSchedules.failureStreak,
    })
    .from(contentSourceSchedules)
    .where(eq(contentSourceSchedules.partitionId, partition.partitionId));
  expect(exhaustedSchedule?.circuitState).toBe('OPEN');
  expect(exhaustedSchedule?.failureStreak).toBe(3);
  expect((exhaustedSchedule?.checkpoint as { windowEnd?: string }).windowEnd).toBe(
    exhaustedRun?.windowEnd?.toISOString(),
  );
});
