import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueXIdentityRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import { HostGrokRunnerClient } from '../../src/content/acquisition/host-grok-runner-client';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { compileXBudgetPolicy } from '../../src/content/acquisition/x-budget';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalXWorker } from '../../src/content/workers/formal-x.worker';
import {
  contentAcquisitionProviderTraces,
  contentAcquisitionRuns,
  contentSourceEndpoints,
  contentSources,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';

const liveTest = process.env.RUN_BRIEFING_FULL_X_IDENTITY === '1' ? test : test.skip;
const CONCURRENCY = 2;

type RunMetrics = Readonly<{
  durationMs?: number;
  totalCostUsd?: number | null;
}>;

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? null;
}

afterAll(async () => {
  await databaseSingleton.disconnect();
});

liveTest(
  'resolves every manifest X account through bounded real Grok Build identity calls',
  async () => {
    const bundle = await loadBriefingManifest();
    const expectedEndpointKeys = bundle.sources.entities
      .filter((entity) =>
        ['OFFICIAL_FPL', 'LEAGUE_OFFICIAL', 'CLUB_OFFICIAL'].includes(entity.sourceType),
      )
      .flatMap((entity) => entity.endpoints)
      .filter((endpoint) => endpoint.adapterKind === 'X_ACCOUNT' && endpoint.enabled)
      .map((endpoint) => endpoint.endpointKey)
      .sort();
    const budgetPolicy = compileXBudgetPolicy({
      coverage: bundle.coverage,
      globalRolling24hLimit: 2_400,
      final90Rolling90mLimit: 300,
      identityRolling24hLimit: 100,
    });
    await reconcileBriefingSourceRegistry({
      bundle,
      gitRevision: 'full-x-identity-live-rollout',
    });
    const db = await getDb();
    const endpoints = await db
      .select({
        endpointId: contentSourceEndpoints.endpointId,
        endpointKey: contentSourceEndpoints.endpointKey,
        sourceId: contentSourceEndpoints.sourceId,
        identityRequirement: contentSourceEndpoints.identityRequirement,
        identityStatus: contentSourceEndpoints.identityStatus,
      })
      .from(contentSourceEndpoints)
      .where(eq(contentSourceEndpoints.adapterKind, 'X_ACCOUNT'));
    expect(
      endpoints
        .filter((endpoint) => endpoint.identityRequirement === 'REQUIRED')
        .map((endpoint) => endpoint.endpointKey)
        .sort(),
    ).toEqual(expectedEndpointKeys);
    expect(endpoints.every((endpoint) => endpoint.identityStatus !== 'CONFLICT')).toBe(true);

    const sourceIds = endpoints.map((endpoint) => endpoint.sourceId);
    const dueEndpointIds = endpoints
      .filter(
        (endpoint) =>
          endpoint.identityRequirement === 'REQUIRED' && endpoint.identityStatus !== 'VERIFIED',
      )
      .map((endpoint) => endpoint.endpointId);
    await db
      .update(contentSources)
      .set({ status: 'active' })
      .where(inArray(contentSources.sourceId, sourceIds));
    await db
      .update(contentSourceEndpoints)
      .set({ status: 'active' })
      .where(eq(contentSourceEndpoints.adapterKind, 'X_ACCOUNT'));
    if (dueEndpointIds.length > 0) {
      await db
        .update(contentSourceEndpoints)
        .set({ identityNextCheckAt: sql`now()` })
        .where(inArray(contentSourceEndpoints.endpointId, dueEndpointIds));
    }

    const flags = {
      ...getContentRuntimeFlags(),
      pipelineEnabled: true,
      acquisitionShadowMode: true,
      xScanEnabled: true,
      realGrokEnabled: true,
    };
    const executor = new HostGrokRunnerClient({
      socketPath: flags.grokRunnerSocket,
      expectedVersion: flags.grokExpectedVersion,
      expectedRunnerReleaseSha: flags.grokRunnerReleaseSha,
      timeoutMs: flags.grokTimeoutMs,
      maximumResponseBytes: flags.grokMaxOutputBytes,
    });
    const runIds: string[] = [];
    let thrownExecutions = 0;

    while (runIds.length < dueEndpointIds.length) {
      const claimed = await claimDueXIdentityRuns({
        claimLimit: Math.min(CONCURRENCY, dueEndpointIds.length - runIds.length),
        budgetPolicy,
      });
      if (claimed.length === 0) break;
      await Promise.all(claimed.map((run) => confirmFormalRunEnqueued({ runId: run.runId })));
      runIds.push(...claimed.map((run) => run.runId));
      const results = await Promise.allSettled(
        claimed.map((run) =>
          runFormalXWorker(run.job, {
            flags,
            executor,
            xBudgetPolicy: budgetPolicy,
          }),
        ),
      );
      thrownExecutions += results.filter((result) => result.status === 'rejected').length;
      console.warn(
        `[briefing-x-identity] attempted ${runIds.length}/${dueEndpointIds.length}; process errors ${thrownExecutions}`,
      );
    }

    const resolved = await db
      .select({
        endpointId: contentSourceEndpoints.endpointId,
        endpointKey: contentSourceEndpoints.endpointKey,
        stableExternalId: contentSourceEndpoints.stableExternalId,
        identityRequirement: contentSourceEndpoints.identityRequirement,
        identityStatus: contentSourceEndpoints.identityStatus,
        identityErrorSummary: contentSourceEndpoints.identityErrorSummary,
      })
      .from(contentSourceEndpoints)
      .where(eq(contentSourceEndpoints.adapterKind, 'X_ACCOUNT'));
    const runs =
      runIds.length === 0
        ? []
        : await db
            .select({
              runId: contentAcquisitionRuns.runId,
              endpointId: contentAcquisitionRuns.endpointId,
              status: contentAcquisitionRuns.status,
              failureClass: contentAcquisitionRuns.failureClass,
              runMetrics: contentAcquisitionRuns.runMetrics,
            })
            .from(contentAcquisitionRuns)
            .where(inArray(contentAcquisitionRuns.runId, runIds));
    const traces =
      runIds.length === 0
        ? []
        : await db
            .select({ runId: contentAcquisitionProviderTraces.runId })
            .from(contentAcquisitionProviderTraces)
            .where(inArray(contentAcquisitionProviderTraces.runId, runIds));
    const durations = runs
      .map((run) => (run.runMetrics as RunMetrics).durationMs)
      .filter((duration): duration is number => typeof duration === 'number');
    const knownCosts = runs
      .map((run) => (run.runMetrics as RunMetrics).totalCostUsd)
      .filter((cost): cost is number => typeof cost === 'number');
    const unresolved = resolved
      .filter(
        (endpoint) =>
          endpoint.identityRequirement === 'REQUIRED' && endpoint.identityStatus !== 'VERIFIED',
      )
      .map((endpoint) => ({
        endpointKey: endpoint.endpointKey,
        identityStatus: endpoint.identityStatus,
        failureClass:
          runs.find((run) => run.endpointId === endpoint.endpointId && run.status === 'FAILED')
            ?.failureClass ?? null,
        error: endpoint.identityErrorSummary,
      }));
    console.warn(
      JSON.stringify({
        registered: expectedEndpointKeys.length,
        dueAtStart: dueEndpointIds.length,
        attempted: runIds.length,
        verified: resolved.filter(
          (endpoint) =>
            endpoint.identityRequirement === 'REQUIRED' && endpoint.identityStatus === 'VERIFIED',
        ).length,
        unresolved,
        traceCount: traces.length,
        thrownExecutions,
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        knownCostRunCount: knownCosts.length,
        totalKnownCostUsd: Number(knownCosts.reduce((sum, cost) => sum + cost, 0).toFixed(8)),
      }),
    );

    expect(runIds).toHaveLength(dueEndpointIds.length);
    expect(thrownExecutions).toBe(0);
    expect(traces).toHaveLength(dueEndpointIds.length);
    expect(unresolved).toEqual([]);
    expect(
      resolved.every(
        (endpoint) =>
          endpoint.identityRequirement !== 'REQUIRED' ||
          (endpoint.identityStatus === 'VERIFIED' && /^\d+$/.test(endpoint.stableExternalId ?? '')),
      ),
    ).toBe(true);
  },
  30 * 60_000,
);
