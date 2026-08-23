import { readFileSync } from 'node:fs';

import { describe, expect, mock, test } from 'bun:test';

import {
  createSchedulerRegistry,
  officialH2HDefinition,
  resolveEntryInfoSnapshotTargetEventId,
  resolvePostMatchResultPlans,
  type ScheduledJobDefinition,
} from '../../src/scheduler/job-registry';
import {
  resolveSchedulerDefinition,
  schedulerPlanKey,
} from '../../src/scheduler/scheduler.service';
import { resolvePlayerStatsActiveCadence } from '../../src/domain/job-schedules';
import { mockFixture1 } from '../fixtures/fixtures.fixtures';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

describe('standalone scheduler registry', () => {
  const registry = createSchedulerRegistry();

  test('keeps picks and transfers on the same event-checkpoint window', () => {
    const picks = registry.find((definition) => definition.name === 'entry-picks');
    const transfers = registry.find((definition) => definition.name === 'entry-transfers');

    expect(picks).toMatchObject({
      catchUpPolicy: 'checkpoint',
      queueName: 'entry-sync',
      cadence: 'post-deadline window',
    });
    expect(transfers).toMatchObject({
      catchUpPolicy: 'checkpoint',
      queueName: 'entry-sync',
      cadence: 'post-deadline window',
    });
    expect(picks?.successPredicate).toContain('entry picks checkpoint');
    expect(transfers?.successPredicate).toContain('entry transfers checkpoint');
  });

  test('registers maintenance work on the queue-owned scheduler', () => {
    const maintenance = registry.filter((definition) => definition.queueName === 'maintenance');
    expect(maintenance.map((definition) => definition.name)).toEqual(
      expect.arrayContaining([
        'player-market-freshness-watchdog',
        'player-season-summary-repair',
        'tournament-trends-repair',
        'bug-report-cleanup',
        'bug-report-screenshot-retention',
        'launch-monitor',
        'post-match-consolidation',
      ]),
    );
    expect(registry.find((definition) => definition.name === 'content-acquisition')).toMatchObject({
      manualTrigger: false,
      queueName: 'content-*',
    });
  });

  test('does not claim downstream completion for the post-match coordinator', () => {
    const coordinator = registry.find(
      (definition) => definition.name === 'post-match-consolidation',
    );
    expect(coordinator?.successPredicate).toContain('enqueues downstream checkpoint jobs');
    expect(coordinator?.successPredicate).not.toContain('checkpoints advance');
  });

  test('isolates one resolver failure so unrelated definitions can continue', async () => {
    const expectedError = new Error('source-specific read unavailable');
    const definition: ScheduledJobDefinition = {
      name: 'controlled-failure',
      cadence: 'test-only',
      timezone: 'UTC',
      catchUpPolicy: 'none',
      criticality: 'normal',
      queueName: 'test-only',
      successPredicate: 'never reached',
      resolve: async () => {
        throw expectedError;
      },
      enqueue: async () => undefined,
    };
    const resolution = await resolveSchedulerDefinition(definition, {
      season: TEST_SEASON,
      now: new Date('2026-08-23T01:00:00.000Z'),
      events: [],
    });

    expect(resolution).toEqual({ ok: false, error: expectedError });
    const schedulerSource = readFileSync('src/scheduler.ts', 'utf8');
    expect(schedulerSource).toContain('runIndependentSchedulerStage');
    expect(schedulerSource).toContain('obligation-registry');
  });

  test('limits active player-stat refreshes to lifecycle states that can still change', () => {
    const ordinaryMinute = new Date('2026-08-22T10:17:00.000Z');
    const fiveMinuteBoundary = new Date('2026-08-22T10:20:00.000Z');

    expect(resolvePlayerStatsActiveCadence('LIVE_ACTIVE', ordinaryMinute)).toBe('one-minute');
    expect(resolvePlayerStatsActiveCadence('DAY_SETTLING', ordinaryMinute)).toBe('one-minute');
    expect(resolvePlayerStatsActiveCadence('BETWEEN_FIXTURES', ordinaryMinute)).toBeNull();
    expect(resolvePlayerStatsActiveCadence('BETWEEN_FIXTURES', fiveMinuteBoundary)).toBe(
      'five-minute',
    );
    expect(resolvePlayerStatsActiveCadence('GW_REVIEW', fiveMinuteBoundary)).toBe('five-minute');
    expect(resolvePlayerStatsActiveCadence('PICKS_SYNC', fiveMinuteBoundary)).toBe('five-minute');
    expect(resolvePlayerStatsActiveCadence('PRE_DEADLINE', fiveMinuteBoundary)).toBeNull();
    expect(resolvePlayerStatsActiveCadence('PICKS_WAIT', fiveMinuteBoundary)).toBeNull();
    expect(resolvePlayerStatsActiveCadence('PICKS_PROBE', fiveMinuteBoundary)).toBeNull();
    expect(resolvePlayerStatsActiveCadence('FINALIZED', fiveMinuteBoundary)).toBeNull();
  });

  test('runs official H2H through the durable standalone scheduler during match windows', async () => {
    const event = {
      id: 1,
      name: 'GW1',
      deadlineTime: '2026-08-23T12:00:00.000Z',
      averageEntryScore: null,
      finished: false,
      dataChecked: false,
      highestScoringEntry: null,
      deadlineTimeEpoch: null,
      deadlineTimeGameOffset: null,
      highestScore: null,
      isPrevious: false,
      isCurrent: true,
      isNext: false,
      cupLeagueCreate: false,
      h2hKoMatchesCreated: false,
      chipPlays: null,
      mostSelected: null,
      mostTransferredIn: null,
      topElement: null,
      topElementInfo: null,
      transfersMade: null,
      mostCaptained: null,
      mostViceCaptained: null,
      createdAt: null,
      updatedAt: null,
      dataCheckedAt: null,
    };
    const fixtures = [
      {
        id: 101,
        code: 101,
        event: 1,
        finished: false,
        finishedProvisional: false,
        kickoffTime: new Date('2026-08-23T18:00:00.000Z'),
        minutes: 30,
        provisionalStartTime: false,
        started: true,
        teamA: 1,
        teamAScore: 0,
        teamH: 2,
        teamHScore: 0,
        stats: [],
        teamHDifficulty: null,
        teamADifficulty: null,
        pulseId: 101,
        createdAt: null,
        updatedAt: null,
      },
    ];
    let officialJobPending = false;
    let returnPendingRace = false;
    const hasPending = mock(async () => officialJobPending);
    const enqueue = mock(async (..._args: unknown[]) => ({
      id: 'official-job',
      data: { runId: 'official-run' },
    }));
    const definition = officialH2HDefinition({
      findEvent: async () => event,
      findFixtures: async () => fixtures,
      hasPending,
      enqueue: (async (...args: unknown[]) =>
        returnPendingRace ? null : enqueue(...args)) as never,
    });
    const context = {
      season: TEST_SEASON,
      currentEventId: 1,
      now: new Date('2026-08-23T18:30:42.000Z'),
      events: [{ id: 1, deadlineTime: new Date('2026-08-23T12:00:00.000Z') }],
    };

    expect(definition).toMatchObject({
      name: 'tournament-official-h2h-live',
      catchUpPolicy: 'latest-authoritative',
      queueName: 'tournament-sync',
      manualTrigger: false,
    });
    const plans = await definition.resolve(context);
    expect(plans).toEqual([
      expect.objectContaining({
        scopeKey: '2627:event:1',
        periodKey: 'official-h2h-1-202608231830',
        dueAt: new Date('2026-08-23T18:30:00.000Z'),
        eventId: 1,
        source: 'reconcile',
      }),
    ]);
    await definition.enqueue({
      context,
      plan: plans[0]!,
      obligationId: 'official-obligation',
      generation: 2,
    });
    expect(enqueue).toHaveBeenCalledWith(TEST_SEASON, 1, 'reconcile', {
      jobId: 'scheduler-official-obligation-g2',
      obligationId: 'official-obligation',
      obligationGeneration: 2,
    });
    officialJobPending = true;
    expect(
      await definition.resolve({ ...context, now: new Date('2026-08-23T18:31:00.000Z') }),
    ).toEqual([]);
    expect(hasPending).toHaveBeenLastCalledWith(TEST_SEASON, 1);
    officialJobPending = false;
    returnPendingRace = true;
    const racedPlans = await definition.resolve({
      ...context,
      now: new Date('2026-08-23T18:32:00.000Z'),
    });
    await expect(
      definition.enqueue({
        context,
        plan: racedPlans[0]!,
        obligationId: 'raced-official-obligation',
        generation: 1,
      }),
    ).rejects.toThrow('Official H2H job became pending before enqueue');
    expect(
      await definition.resolve({ ...context, now: new Date('2026-08-24T01:00:00.000Z') }),
    ).toEqual([]);
  });

  test('catches up an hourly maintenance bucket after its scheduled minute', async () => {
    const summary = registry.find(
      (definition) => definition.name === 'player-season-summary-repair',
    );
    const plans = await summary!.resolve({
      season: TEST_SEASON,
      now: new Date('2026-08-22T10:18:00.000Z'),
      events: [],
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]?.dueAt).toEqual(new Date('2026-08-22T10:17:00.000Z'));
  });

  test('records expired market dates without replaying them', async () => {
    const market = registry.find((definition) => definition.name === 'market-daily');
    const plans = await market!.resolve({
      season: TEST_SEASON,
      // 10:00 UTC is already after the 09:25 UTC+8 window on 2026-08-22.
      now: new Date('2026-08-22T10:00:00.000Z'),
      events: [],
    });

    expect(plans).toHaveLength(32);
    expect(plans.find((plan) => plan.periodKey === '20260821')).toMatchObject({
      source: 'reconcile',
      terminalStatus: 'irrecoverable',
    });
    expect(plans.find((plan) => plan.periodKey === '20260822')).toMatchObject({
      source: 'catchup',
    });
    expect(plans.find((plan) => plan.periodKey === '20260822')?.terminalStatus).toBeUndefined();
  });

  test('catches up the latest authoritative daily checkpoint before today is due', async () => {
    const core = registry.find((definition) => definition.name === 'core-snapshot');
    const plans = await core!.resolve({
      season: TEST_SEASON,
      // 05:00 UTC+8 on Aug 23 is before today's 06:35 checkpoint.
      now: new Date('2026-08-22T21:00:00.000Z'),
      events: [],
    });

    expect(plans).toEqual([
      expect.objectContaining({
        periodKey: '20260822',
        dueAt: new Date('2026-08-21T22:35:00.000Z'),
        source: 'catchup',
      }),
    ]);
  });

  test('never replays the market watchdog for an expired date', async () => {
    const watchdog = registry.find(
      (definition) => definition.name === 'player-market-freshness-watchdog',
    );
    const beforeDue = await watchdog!.resolve({
      season: TEST_SEASON,
      now: new Date('2026-08-22T21:00:00.000Z'),
      events: [],
    });
    const afterDue = await watchdog!.resolve({
      season: TEST_SEASON,
      now: new Date('2026-08-23T01:37:00.000Z'),
      events: [],
    });

    expect(beforeDue).toHaveLength(31);
    expect(beforeDue.every((plan) => plan.terminalStatus === 'irrecoverable')).toBe(true);
    expect(beforeDue.some((plan) => plan.periodKey === '20260823')).toBe(false);
    const today = afterDue.find((plan) => plan.periodKey === '20260823');
    expect(today).toMatchObject({
      dueAt: new Date('2026-08-23T01:36:00.000Z'),
    });
    expect(today?.terminalStatus).toBeUndefined();
  });

  test('uses terminal status in the observed-plan LRU key', () => {
    const definition = { name: 'market-daily' };
    const active = schedulerPlanKey(definition, {
      scopeKey: '2627',
      periodKey: '20260823',
    });
    const expired = schedulerPlanKey(definition, {
      scopeKey: '2627',
      periodKey: '20260823',
      terminalStatus: 'irrecoverable',
    });

    expect(active).not.toBe(expired);
  });

  test('targets entry snapshots at the latest finalized event', () => {
    expect(resolveEntryInfoSnapshotTargetEventId({ latestFinalizedEventId: 8 })).toBe(8);
    expect(resolveEntryInfoSnapshotTargetEventId({})).toBe(0);
  });

  test('opens result checkpoints only after the final fixture expected end', async () => {
    const baseContext = {
      season: TEST_SEASON,
      now: new Date('2026-08-22T18:01:00.000Z'),
      events: [
        {
          id: 1,
          deadlineTime: new Date('2026-08-22T17:30:00.000Z'),
          finished: false,
          dataChecked: false,
          dataCheckedAt: null,
        },
      ],
    };
    const fixtures = [{ ...mockFixture1, kickoffTime: new Date('2026-08-22T18:00:00.000Z') }];
    const loadFixtures = async () => fixtures;

    expect(await resolvePostMatchResultPlans(baseContext, loadFixtures)).toEqual([]);
    expect(
      await resolvePostMatchResultPlans(
        { ...baseContext, now: new Date('2026-08-22T20:10:00.000Z') },
        loadFixtures,
      ),
    ).toEqual([
      expect.objectContaining({
        periodKey: 'event-1-provisional-0',
        eventId: 1,
        source: 'reconcile',
      }),
    ]);
  });

  test('bounds hourly result slots to 24 hours', async () => {
    const fixtures = [{ ...mockFixture1, kickoffTime: new Date('2026-08-22T18:00:00.000Z') }];
    const context = {
      season: TEST_SEASON,
      now: new Date('2026-08-23T19:59:59.000Z'),
      events: [
        {
          id: 1,
          deadlineTime: new Date('2026-08-22T17:30:00.000Z'),
          finished: false,
          dataChecked: false,
        },
      ],
    };
    const loadFixtures = async () => fixtures;

    expect(await resolvePostMatchResultPlans(context, loadFixtures)).toEqual([
      expect.objectContaining({ periodKey: 'event-1-provisional-23' }),
    ]);
    expect(
      await resolvePostMatchResultPlans(
        { ...context, now: new Date('2026-08-23T20:00:00.000Z') },
        loadFixtures,
      ),
    ).toEqual([]);
  });

  test('keeps one permanent final result checkpoint for every finalized event', async () => {
    let fixtureLoads = 0;
    const checkedAt = new Date('2026-08-22T22:00:00.000Z');
    const plans = await resolvePostMatchResultPlans(
      {
        season: TEST_SEASON,
        now: new Date('2026-08-25T12:00:00.000Z'),
        events: [
          {
            id: 2,
            deadlineTime: new Date('2026-08-22T17:30:00.000Z'),
            finished: true,
            dataChecked: true,
            dataCheckedAt: checkedAt,
          },
          {
            id: 1,
            deadlineTime: new Date('2026-08-15T17:30:00.000Z'),
            finished: true,
            dataChecked: true,
            dataCheckedAt: new Date('2026-08-15T22:00:00.000Z'),
          },
        ],
      },
      async () => {
        fixtureLoads += 1;
        return [];
      },
    );

    expect(plans.map((plan) => plan.periodKey)).toEqual(['event-2-final', 'event-1-final']);
    expect(plans[0]).toMatchObject({ dueAt: checkedAt, source: 'catchup' });
    expect(fixtureLoads).toBe(0);
  });

  test('resolves picks and transfers to the same event checkpoint window', async () => {
    const events = [{ id: 1, deadlineTime: new Date('2026-08-21T17:30:00.000Z') }];
    const context = { season: TEST_SEASON, now: new Date('2026-08-21T18:01:00.000Z'), events };
    const picks = registry.find((definition) => definition.name === 'entry-picks');
    const transfers = registry.find((definition) => definition.name === 'entry-transfers');

    const [pickPlans, transferPlans] = await Promise.all([
      picks!.resolve(context),
      transfers!.resolve(context),
    ]);
    expect(pickPlans).toEqual(transferPlans);
    expect(pickPlans[0]).toMatchObject({
      scopeKey: '2627:event:1',
      periodKey: 'event-1',
      eventId: 1,
      source: 'catchup',
    });
  });
});
