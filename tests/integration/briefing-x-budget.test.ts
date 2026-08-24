import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { randomUUID } from 'node:crypto';

import { afterAll, expect, test } from 'bun:test';
import { eq, inArray, notInArray, sql } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueXIdentityRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { compileXBudgetPolicy, reserveXRunBudgets } from '../../src/content/acquisition/x-budget';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalXWorker } from '../../src/content/workers/formal-x.worker';
import {
  contentAcquisitionBudgetReservations,
  contentAcquisitionRuns,
  contentSourceEndpoints,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';
import { resetBriefingAcquisitionState } from './helpers/briefing-acquisition-reset';

afterAll(async () => {
  await databaseSingleton.disconnect();
});

test('atomically defers X work beyond the rolling cap and commits only executed calls', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'x-budget-test' });
  const db = await getDb();
  const endpoints = await db
    .select({ endpointId: contentSourceEndpoints.endpointId })
    .from(contentSourceEndpoints)
    .where(inArray(contentSourceEndpoints.endpointKey, ['official-fpl-x', 'premier-league-x']));
  expect(endpoints).toHaveLength(2);
  await db
    .update(contentSourceEndpoints)
    .set({ status: 'paused' })
    .where(
      notInArray(
        contentSourceEndpoints.endpointId,
        endpoints.map((endpoint) => endpoint.endpointId),
      ),
    );
  const budgetPolicy = compileXBudgetPolicy({
    coverage: bundle.coverage,
    globalRolling24hLimit: 1,
    final90Rolling90mLimit: 1,
    identityRolling24hLimit: 10,
  });

  const [left, right] = await Promise.all([
    claimDueXIdentityRuns({ claimLimit: 2, budgetPolicy }),
    claimDueXIdentityRuns({ claimLimit: 2, budgetPolicy }),
  ]);
  const claimed = [...left, ...right];
  expect(claimed).toHaveLength(1);
  const runCounts = await db
    .select({ status: contentAcquisitionRuns.status, count: sql<number>`count(*)::int` })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.jobKind, 'X_IDENTITY'))
    .groupBy(contentAcquisitionRuns.status);
  expect(runCounts).toEqual(
    expect.arrayContaining([
      { status: 'PENDING', count: 1 },
      { status: 'BUDGET_DEFERRED', count: 1 },
    ]),
  );

  expect(await confirmFormalRunEnqueued({ runId: claimed[0]!.runId })).toBe(true);
  const result = await runFormalXWorker(claimed[0]!.job, {
    flags: {
      ...getContentRuntimeFlags(),
      pipelineEnabled: true,
      acquisitionShadowMode: true,
      xScanEnabled: true,
      realGrokEnabled: true,
    },
    executor: {
      execute: async (request) => {
        if (request.toolName !== 'x_user_search') throw new Error('Expected identity request');
        return {
          toolName: 'x_user_search' as const,
          toolInput: { query: request.handle, count: 3 },
          posts: [],
          users: [
            {
              userId:
                request.handle.toLowerCase() === 'officialfpl' ? '761568335138058240' : '343627165',
              handle: request.handle,
              displayName: request.handle,
            },
          ],
          requestMetadataHash: 'a'.repeat(64),
          responseMetadataHash: 'b'.repeat(64),
          traceHash: 'c'.repeat(64),
          toolCallIdHash: 'd'.repeat(64),
          eventCount: 5,
          durationMs: 100,
          inputTokens: 100,
          outputTokens: 20,
          totalCostUsd: 0.01,
          rawPostEvidenceAvailable: false as const,
        };
      },
    },
  });
  expect(result.status).toBe('COMPLETED');
  const reservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, claimed[0]!.runId));
  expect(reservations).toHaveLength(2);
  expect(reservations.every((reservation) => reservation.status === 'COMMITTED')).toBe(true);
});

test('shadow budget bypasses recurring lane caps but keeps the global guard', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  const db = await getDb();
  const coverage = {
    ...bundle.coverage,
    xLaneCallCaps: {
      ...bundle.coverage.xLaneCallCaps,
      NORMAL: {
        ...bundle.coverage.xLaneCallCaps.NORMAL,
        OFFICIAL: 1,
      },
    },
  };
  const recurringPolicy = compileXBudgetPolicy({
    coverage,
    globalRolling24hLimit: 100,
    final90Rolling90mLimit: 10,
    identityRolling24hLimit: 1,
    enforceLaneCaps: true,
  });
  const shadowPolicy = compileXBudgetPolicy({
    coverage,
    globalRolling24hLimit: 100,
    final90Rolling90mLimit: 10,
    identityRolling24hLimit: 1,
    enforceLaneCaps: false,
  });

  const createRun = async (runId: string) => {
    const now = new Date();
    await db.insert(contentAcquisitionRuns).values({
      runId,
      windowStart: now,
      windowEnd: now,
      idempotencyKey: `shadow-budget-test:${runId}`,
      status: 'PENDING',
    });
  };

  const reserve = (policy: typeof recurringPolicy, runId: string, lane: 'IDENTITY' | 'OFFICIAL') =>
    db.transaction(async (tx) => {
      return reserveXRunBudgets({
        tx,
        runId,
        phase: 'NORMAL',
        lane,
        dbNow: new Date(),
        policy,
      });
    });

  const firstRunId = randomUUID();
  await createRun(firstRunId);
  const first = await reserve(recurringPolicy, firstRunId, 'OFFICIAL');
  expect(first.reserved).toBe(true);

  const blockedRunId = randomUUID();
  await createRun(blockedRunId);
  const recurringBlocked = await reserve(recurringPolicy, blockedRunId, 'OFFICIAL');
  expect(recurringBlocked).toMatchObject({
    reserved: false,
    deferredScope: 'LANE:NORMAL:OFFICIAL',
    remainingBeforeReservation: 0,
  });

  const shadowRunId = randomUUID();
  await createRun(shadowRunId);
  const shadowAllowed = await reserve(shadowPolicy, shadowRunId, 'OFFICIAL');
  expect(shadowAllowed.reserved).toBe(true);
  expect(shadowAllowed.deferredScope).toBeNull();

  const identityFirstRunId = randomUUID();
  await createRun(identityFirstRunId);
  const identityFirst = await reserve(recurringPolicy, identityFirstRunId, 'IDENTITY');
  expect(identityFirst.reserved).toBe(true);

  const identityBlockedRunId = randomUUID();
  await createRun(identityBlockedRunId);
  const identityBlocked = await reserve(recurringPolicy, identityBlockedRunId, 'IDENTITY');
  expect(identityBlocked).toMatchObject({
    reserved: false,
    deferredScope: 'LANE:IDENTITY',
    remainingBeforeReservation: 0,
  });

  const identityShadowRunId = randomUUID();
  await createRun(identityShadowRunId);
  const identityShadowAllowed = await reserve(shadowPolicy, identityShadowRunId, 'IDENTITY');
  expect(identityShadowAllowed.reserved).toBe(true);
  expect(identityShadowAllowed.deferredScope).toBeNull();
});
