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
} from '../../src/services/queue-governance.service';
import { queueHealthRetentionCutoff } from '../../src/services/queue-governance.service';
import { summarizeDataError } from '../../src/domain/error-classification';
import { resolveOfficialH2HPagesToFetch } from '../../src/services/tournament-official-h2h.service';
import { missingLockedPageNumbers } from '../../src/domain/official-h2h-manifest';
import {
  dataContractRegistry,
  canonicalQueueCatalog,
  queueRuntimeCatalog,
} from '../../src/domain/data-contracts';
import { MAINTENANCE_JOBS } from '../../src/queues/maintenance.queue';
import { MAINTENANCE_JOB_LANES } from '../../src/jobs/maintenance.jobs';

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

  test('calculates bounded drain ETA and percentiles', () => {
    expect(calculateDrainEtaMs(0, 10, 1)).toBe(0);
    expect(calculateDrainEtaMs(20, 10, 20)).toBe(120_000);
    expect(calculateDrainEtaMs(20, 10, 10)).toBeNull();
    expect(percentile([30, 10, 20], 0.5)).toBe(20);
    expect(percentile([], 0.95)).toBeNull();
  });

  test('keeps queue-health retention bounded at a deterministic cutoff', () => {
    expect(queueHealthRetentionCutoff(new Date('2026-08-27T00:00:00.000Z'), 35)).toEqual(
      new Date('2026-07-23T00:00:00.000Z'),
    );
    expect(() => queueHealthRetentionCutoff(new Date(), 0)).toThrow(
      'Queue health retention days must be a positive integer',
    );
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
    expect(calculateBurnRate(1, 100, 0.99)).toBeCloseTo(1, 10);
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
