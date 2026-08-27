import { describe, expect, test } from 'bun:test';

import { countEntryEligibility, isEntryEligibleForEvent } from '../../src/domain/entry-eligibility';
import {
  applyFreshnessObservation,
  calculateBurnRate,
  evaluateFreshnessWindow,
  isCompleteCount,
  revisionsAgree,
} from '../../src/domain/freshness-slo';
import {
  classifyBacklog,
  calculateDrainEtaMs,
  percentile,
  resolveQueueHealthState,
} from '../../src/services/queue-governance.service';
import {
  resolveJobDispatchBudgetMs,
  resolveQueueDispatchBudgetMs,
  resolveQueueTimingMetrics,
} from '../../src/utils/queue-monitor';
import { queueHealthRetentionCutoff } from '../../src/services/queue-governance.service';
import { summarizeDataError } from '../../src/domain/error-classification';
import { resolveOfficialH2HPagesToFetch } from '../../src/services/tournament-official-h2h.service';
import { missingLockedPageNumbers } from '../../src/domain/official-h2h-manifest';
import {
  assertDataContractRegistry,
  contractHasConsumerEvidence,
  dataContractRegistry,
  canonicalQueueCatalog,
  queueRuntimeCatalog,
  type DataContract,
} from '../../src/domain/data-contracts';
import { MAINTENANCE_JOBS } from '../../src/queues/maintenance.queue';
import { MAINTENANCE_JOB_LANES } from '../../src/jobs/maintenance.jobs';
import {
  consumerProbeUrl,
  freshnessRepairLaneForWindow,
  selectFreshnessRecoveryRevision,
} from '../../src/services/data-governance.service';
import { shouldCreateFreshnessWindowForObligation } from '../../src/scheduler/scheduler.service';

describe('GW queue and data governance primitives', () => {
  test('uses one late-entry denominator rule across GW1-GW4', () => {
    const startedAt = [null, 1, 2, 3, 4] as const;
    const expected = [true, true, true, true, false];
    for (const eventId of [1, 2, 3, 4]) {
      expect(
        startedAt.map((startedEvent) => isEntryEligibleForEvent({ startedEvent, eventId })),
      ).toEqual(expected.map((value, index) => (index <= eventId ? true : value && index === 0)));
    }
    expect(
      countEntryEligibility([
        { startedEvent: null, eventId: 1 },
        { startedEvent: 4, eventId: 3 },
        { startedEvent: 4, eventId: 4 },
      ]),
    ).toEqual({ eligibleCount: 2, notApplicableCount: 1 });
  });

  test('prioritizes consumer and poison failures before latency classes', () => {
    expect(
      classifyBacklog({ waiting: 4, active: 0, failed: 0, consumerHeartbeatAgeMs: null }),
    ).toBe('NO_CONSUMER');
    expect(classifyBacklog({ waiting: 10, active: 0, failed: 8, arrivalsPerMinute: 10 })).toBe(
      'POISON_STORM',
    );
    expect(classifyBacklog({ waiting: 1, active: 0, failed: 0, stalled: 1 })).toBe('STALLED');
    expect(
      classifyBacklog({
        waiting: 1,
        active: 0,
        failed: 0,
        oldestRunnableAgeMs: 61_000,
        dispatchBudgetMs: 60_000,
      }),
    ).toBe('DEADLINE_RISK');
    expect(classifyBacklog({ waiting: 1, active: 0, failed: 0, providerWaitP95Ms: 5_001 })).toBe(
      'PROVIDER_THROTTLED',
    );
  });

  test('derives queue deadline budgets from the contract registry', () => {
    expect(resolveQueueDispatchBudgetMs('data-sync')).toBe(60_000);
    expect(resolveQueueDispatchBudgetMs('entry-sync')).toBe(15 * 60_000);
    expect(resolveQueueDispatchBudgetMs('my-fpl-orchestration')).toBe(15 * 60_000);
    expect(resolveQueueDispatchBudgetMs('maintenance')).toBe(60 * 60_000);
    expect(resolveQueueDispatchBudgetMs('unknown-queue')).toBeUndefined();
    expect(resolveJobDispatchBudgetMs('data-repair', { name: 'tournament-trends-repair' })).toBe(
      60 * 60_000,
    );
    expect(
      resolveJobDispatchBudgetMs('data-repair', { name: 'player-season-summary-repair' }),
    ).toBe(15 * 60_000);
    expect(resolveJobDispatchBudgetMs('data-repair', { name: 'unknown-repair-job' })).toBeNull();
  });

  test('calculates bounded drain ETA and percentiles', () => {
    expect(calculateDrainEtaMs(0, 10, 1)).toBe(0);
    expect(calculateDrainEtaMs(20, 10, 20)).toBe(120_000);
    expect(calculateDrainEtaMs(20, 10, 10)).toBeNull();
    expect(percentile([30, 10, 20], 0.5)).toBe(20);
    expect(percentile([], 0.95)).toBeNull();
  });

  test('excludes retained completed jobs outside the rolling timing window', () => {
    const nowMs = 1_000_000;
    const metrics = resolveQueueTimingMetrics(
      [
        {
          timestamp: nowMs - 60_000,
          processedOn: nowMs - 59_000,
          finishedOn: nowMs - 58_000,
          data: { providerAdmissionWaitMs: 999, providerStatus: 429 },
        },
        {
          timestamp: nowMs - 4_000,
          processedOn: nowMs - 3_000,
          finishedOn: nowMs - 1_000,
          data: { providerAdmissionWaitMs: 12 },
        },
      ],
      { nowMs, lookbackMs: 10_000 },
    );

    expect(metrics).toEqual({
      waitP50Ms: 1_000,
      waitP95Ms: 1_000,
      executionP50Ms: 2_000,
      executionP95Ms: 2_000,
      providerWaitP95Ms: 12,
      provider429Rate: 0,
    });
  });

  test('keeps queue-health retention bounded at a deterministic cutoff', () => {
    expect(queueHealthRetentionCutoff(new Date('2026-08-27T00:00:00.000Z'), 35)).toEqual(
      new Date('2026-07-23T00:00:00.000Z'),
    );
    expect(() => queueHealthRetentionCutoff(new Date(), 0)).toThrow(
      'Queue health retention days must be a positive integer',
    );
  });

  test('distinguishes disabled optional monitors from missing observations', () => {
    expect(resolveQueueHealthState({ snapshot: null, monitorEnabled: false })).toBe('DISABLED');
    expect(resolveQueueHealthState({ snapshot: null, monitorState: 'DISABLED' })).toBe('DISABLED');
    expect(resolveQueueHealthState({ snapshot: null, monitorState: 'STARTING' })).toBe(
      'UNOBSERVED',
    );
    expect(resolveQueueHealthState({ snapshot: null, monitorEnabled: true })).toBe('UNOBSERVED');
    expect(
      resolveQueueHealthState({
        snapshot: {
          queueName: 'data-sync',
          observedAt: '2026-08-27T00:00:00.000Z',
          waiting: 0,
          active: 0,
          delayed: 0,
          prioritized: 0,
          waitingChildren: 0,
          failed: 0,
          completed: 0,
          runnable: 0,
          oldestRunnableAgeMs: null,
          arrivals: 0,
          completions: 0,
          failures: 0,
          stalled: 0,
          waitP50Ms: null,
          waitP95Ms: null,
          executionP50Ms: null,
          executionP95Ms: null,
          providerWaitP95Ms: null,
          provider429Rate: null,
          netGrowth: 0,
          drainEtaMs: 0,
          backlogClass: 'HEALTHY',
          admissionMode: 'OPEN',
          consumerHeartbeatAt: null,
          releaseSha: 'test',
        },
        monitorEnabled: false,
      }),
    ).toBe('DISABLED');
  });

  test('requires all producer and consumer revisions for MET', () => {
    expect(revisionsAgree(['r1', 'r1', 'r1', 'r1'])).toBe(true);
    expect(revisionsAgree(['r1', 'r1', 'r1', null])).toBe(false);
    expect(isCompleteCount(4, 4)).toBe(true);
    expect(isCompleteCount(4, 3)).toBe(false);
    const dueAt = new Date('2026-08-26T00:00:00.000Z');
    expect(
      evaluateFreshnessWindow({
        eligible: true,
        dueAt,
        now: new Date('2026-08-25T23:59:00.000Z'),
        producerRevision: 'r1',
        redisRevision: 'r1',
        graphqlRevision: 'r1',
        webRevision: 'r1',
        sourceCheckedAt: new Date('2026-08-25T23:50:00.000Z'),
        pgPublishedAt: new Date('2026-08-25T23:52:00.000Z'),
        redisSeenAt: new Date('2026-08-25T23:53:00.000Z'),
        graphqlSeenAt: new Date('2026-08-25T23:57:00.000Z'),
        expectedCount: 4,
        observedCount: 4,
        completeness: 'COMPLETE',
        webSeenAt: new Date('2026-08-25T23:58:00.000Z'),
      }),
    ).toBe('MET');
    expect(
      evaluateFreshnessWindow({
        eligible: true,
        dueAt,
        now: new Date('2026-08-25T23:59:00.000Z'),
        producerRevision: 'r1',
        redisRevision: 'r1',
        graphqlRevision: 'r1',
        webRevision: 'r1',
        expectedCount: 4,
        observedCount: 4,
        completeness: 'COMPLETE',
        webSeenAt: new Date('2026-08-25T23:58:00.000Z'),
      }),
    ).toBe('PENDING');
    expect(
      evaluateFreshnessWindow({
        eligible: true,
        consumerEvidenceRequired: false,
        dueAt,
        now: new Date('2026-08-25T23:59:00.000Z'),
        producerRevision: 'r1',
        redisRevision: 'r1',
        sourceCheckedAt: new Date('2026-08-25T23:50:00.000Z'),
        pgPublishedAt: new Date('2026-08-25T23:52:00.000Z'),
        redisSeenAt: new Date('2026-08-25T23:53:00.000Z'),
        expectedCount: 4,
        observedCount: 4,
        completeness: 'COMPLETE',
      }),
    ).toBe('MET');
    expect(
      evaluateFreshnessWindow({ eligible: true, dueAt, now: new Date('2026-08-26T00:01:00.000Z') }),
    ).toBe('BREACHED');
    expect(
      applyFreshnessObservation('BREACHED', {
        eligible: true,
        dueAt,
        completeness: 'COMPLETE',
        sourceCheckedAt: new Date('2026-08-25T23:50:00.000Z'),
        pgPublishedAt: new Date('2026-08-25T23:52:00.000Z'),
        redisSeenAt: new Date('2026-08-25T23:53:00.000Z'),
        graphqlSeenAt: new Date('2026-08-25T23:57:00.000Z'),
        webSeenAt: new Date('2026-08-25T23:58:00.000Z'),
        producerRevision: 'r1',
        redisRevision: 'r1',
        graphqlRevision: 'r1',
        webRevision: 'r1',
        expectedCount: 4,
        observedCount: 4,
      }),
    ).toEqual({ status: 'BREACHED', recovered: true });
    expect(
      applyFreshnessObservation('NOT_APPLICABLE', {
        eligible: false,
        dueAt,
        completeness: 'COMPLETE',
        producerRevision: 'late-checkpoint',
      }),
    ).toEqual({ status: 'NOT_APPLICABLE', recovered: false });
    expect(calculateBurnRate(1, 100, 0.99)).toBeCloseTo(1, 10);
  });

  test('keeps Redis optional for consumer probes on PostgreSQL checkpoints', () => {
    const dueAt = new Date('2026-08-26T00:00:00.000Z');
    const timestamp = new Date('2026-08-25T23:58:00.000Z');
    expect(
      evaluateFreshnessWindow({
        eligible: true,
        consumerEvidenceRequired: true,
        redisEvidenceRequired: false,
        dueAt,
        now: new Date('2026-08-25T23:59:00.000Z'),
        producerRevision: 'checkpoint-1',
        graphqlRevision: 'checkpoint-1',
        webRevision: 'checkpoint-1',
        sourceCheckedAt: timestamp,
        pgPublishedAt: timestamp,
        graphqlSeenAt: timestamp,
        webSeenAt: timestamp,
        expectedCount: 15,
        observedCount: 15,
        completeness: 'COMPLETE',
      }),
    ).toBe('MET');
    expect(
      evaluateFreshnessWindow({
        eligible: true,
        consumerEvidenceRequired: true,
        redisEvidenceRequired: false,
        dueAt,
        now: new Date('2026-08-25T23:59:00.000Z'),
        producerRevision: 'checkpoint-1',
        graphqlRevision: 'checkpoint-1',
        webRevision: 'checkpoint-1',
        sourceCheckedAt: timestamp,
        pgPublishedAt: timestamp,
        graphqlSeenAt: timestamp,
        webSeenAt: timestamp,
        expectedCount: 15,
        observedCount: 14,
        completeness: 'INCOMPLETE',
      }),
    ).toBe('PENDING');
  });

  test('selects only manifest pages containing the current H2H event', () => {
    expect(
      resolveOfficialH2HPagesToFetch(
        [
          { pageNumber: 1, eventIds: [1, 2], lockedAt: '2026-08-25T00:00:00.000Z' },
          { pageNumber: 2, eventIds: [3, 4], lockedAt: '2026-08-25T00:00:00.000Z' },
        ],
        4,
        true,
      ),
    ).toEqual({ mode: 'incremental', pageNumbers: [2] });
    expect(
      resolveOfficialH2HPagesToFetch([{ pageNumber: 1, eventIds: [1], lockedAt: null }], 1, true),
    ).toEqual({ mode: 'full', pageNumbers: [] });
    expect(
      resolveOfficialH2HPagesToFetch(
        [{ pageNumber: 1, eventIds: [1], lockedAt: '2026-08-25T00:00:00.000Z' }],
        4,
        true,
      ),
    ).toEqual({ mode: 'full', pageNumbers: [] });
  });

  test('detects locked H2H pages missing from a guarded full fetch', () => {
    expect(
      missingLockedPageNumbers(
        [
          { pageNumber: 1, lockedAt: '2026-08-25T00:00:00.000Z' },
          { pageNumber: 2, lockedAt: '2026-08-25T00:00:00.000Z' },
          { pageNumber: 3, lockedAt: null },
        ],
        [{ pageNumber: 1 }, { pageNumber: 3 }, { pageNumber: 4 }],
      ),
    ).toEqual([2]);
  });

  test('keeps queue, maintenance and contract catalogs explicit', () => {
    expect(new Set(queueRuntimeCatalog.map((entry) => entry.queueName))).toEqual(
      new Set(canonicalQueueCatalog),
    );
    expect(Object.keys(MAINTENANCE_JOB_LANES).sort()).toEqual(
      Object.values(MAINTENANCE_JOBS).sort(),
    );
    const registryJobs = new Set(
      dataContractRegistry.flatMap((contract) => contract.schedulerJobs),
    );
    expect(registryJobs.size).toBeGreaterThanOrEqual(35);
    expect(() => assertDataContractRegistry([...registryJobs])).not.toThrow();
    const contracts: readonly DataContract[] = dataContractRegistry;
    expect(
      contracts
        .filter((contract) => contract.freshnessEvidence === 'checkpoint')
        .every((contract) => (contract.freshnessJobs?.length ?? 0) > 0),
    ).toBe(true);
    expect(
      dataContractRegistry.find((contract) => contract.contractKey === 'my-fpl'),
    ).toMatchObject({
      consumerEvidence: {
        redis: 'active snapshot manifest and publication outbox',
      },
    });
    expect(
      dataContractRegistry
        .filter(
          (contract) =>
            contract.visibility === 'internal-only' || contract.visibility === 'excluded',
        )
        .every((contract) => contract.visibilityReason?.trim().length),
    ).toBe(true);
    expect(
      contractHasConsumerEvidence(
        dataContractRegistry.find((contract) => contract.contractKey === 'my-fpl')!,
      ),
    ).toBe(true);
    expect(
      contractHasConsumerEvidence(
        dataContractRegistry.find((contract) => contract.contractKey === 'housekeeping')!,
      ),
    ).toBe(false);
  });

  test('routes My FPL outbox freshness repairs to the publication lane', () => {
    expect(freshnessRepairLaneForWindow('my-fpl', 'outbox-123')).toBe('publication-outbox');
    expect(freshnessRepairLaneForWindow('my-fpl', 'maintenance-123')).toBe('publication-outbox');
  });

  test('settles PostgreSQL checkpoint windows without requiring a Redis pointer', () => {
    const timestamp = new Date('2026-08-27T00:00:00.000Z');
    expect(
      evaluateFreshnessWindow({
        eligible: true,
        consumerEvidenceRequired: false,
        redisEvidenceRequired: false,
        dueAt: new Date('2026-08-27T00:05:00.000Z'),
        sourceCheckedAt: timestamp,
        pgPublishedAt: timestamp,
        producerRevision: 'checkpoint-1',
        expectedCount: 15,
        observedCount: 15,
        completeness: 'COMPLETE',
      }),
    ).toBe('MET');
  });

  test('does not create a freshness window for an old terminal obligation without an identity', () => {
    expect(
      shouldCreateFreshnessWindowForObligation({
        status: 'pending',
        evidence: {},
        runId: null,
        completedAt: null,
      }),
    ).toBe(true);
    expect(
      shouldCreateFreshnessWindowForObligation({
        status: 'succeeded',
        evidence: {},
        runId: null,
        completedAt: null,
      }),
    ).toBe(false);
    expect(
      shouldCreateFreshnessWindowForObligation({
        status: 'succeeded',
        evidence: { freshnessWindowId: 42 },
        runId: 'run-id',
        completedAt: new Date('2026-08-27T00:00:00.000Z'),
      }),
    ).toBe(true);
    expect(
      shouldCreateFreshnessWindowForObligation({
        status: 'skipped',
        evidence: {},
        runId: null,
        completedAt: null,
      }),
    ).toBe(false);
  });

  test('builds the scoped Web consumer probe route', () => {
    expect(consumerProbeUrl('https://web.example/', 'market-price')).toBe(
      'https://web.example/api/ops/data-contracts/market-price',
    );
    expect(consumerProbeUrl('https://web.example', 'entry/data')).toBe(
      'https://web.example/api/ops/data-contracts/entry%2Fdata',
    );
  });

  test('selects recovery revision from the SLO-required final hop', () => {
    expect(
      selectFreshnessRecoveryRevision({
        consumerEvidenceRequired: true,
        redisEvidenceRequired: true,
        webRevision: 'web-r2',
        currentWebRevision: 'web-r1',
        redisRevision: 'redis-r2',
        producerRevision: 'producer-r2',
      }),
    ).toBe('web-r2');
    expect(
      selectFreshnessRecoveryRevision({
        consumerEvidenceRequired: false,
        redisEvidenceRequired: true,
        webRevision: 'stale-web-r1',
        redisRevision: 'redis-r2',
        producerRevision: 'producer-r2',
      }),
    ).toBe('redis-r2');
    expect(
      selectFreshnessRecoveryRevision({
        consumerEvidenceRequired: false,
        redisEvidenceRequired: false,
        webRevision: 'stale-web-r1',
        producerRevision: 'producer-r2',
      }),
    ).toBe('producer-r2');
  });

  test('redacts durable error summaries', () => {
    const summary = summarizeDataError(
      new Error('POST https://provider.invalid/token failed for entryId=1234'),
    );
    expect(summary.summary).not.toContain('provider.invalid');
    expect(summary.summary).not.toContain('1234');
    expect(summary.errorClass).toBe('TRANSIENT_INFRA');
  });
});
