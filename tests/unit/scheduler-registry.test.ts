import { readFileSync } from 'node:fs';

import { describe, expect, mock, test } from 'bun:test';

import {
  createSchedulerRegistry,
  officialH2HDefinition,
  resolvePriceChangeWatchPlans,
  resolveEntryInfoSnapshotTargetEventId,
  selectLiveSnapshotEventIds,
  resolveLiveFinalizationCatchupPlans,
  resolvePostMatchResultPlans,
  playerPricesDefinition,
  schedulerQueueLaneOverride,
  understatDailyDefinition,
  type ScheduledJobDefinition,
} from '../../src/scheduler/job-registry';
import {
  isSchedulerDefinitionEnabled,
  orderSchedulerDefinitionsByEarliestDue,
  orderSchedulerDefinitionsForClaim,
  postMatchReservationWasPersisted,
  resolveSchedulerDefinition,
  schedulerDueProgress,
  schedulerExecutionLanes,
  schedulerPlanKey,
} from '../../src/scheduler/scheduler.service';
import { mockFixture1 } from '../fixtures/fixtures.fixtures';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

describe('standalone scheduler registry', () => {
  const registry = createSchedulerRegistry();

  test('includes the next deadline event for pre-deadline Match observations', () => {
    const now = new Date('2026-08-23T12:00:00.000Z');
    expect(
      selectLiveSnapshotEventIds({
        now,
        currentEventId: 3,
        events: [
          { id: 3, deadlineTime: new Date('2026-08-20T12:00:00.000Z') },
          { id: 4, deadlineTime: new Date('2026-08-30T12:00:00.000Z') },
          { id: 5, deadlineTime: new Date('2026-09-06T12:00:00.000Z') },
        ],
      }),
    ).toEqual([3, 4, 5]);
    expect(
      selectLiveSnapshotEventIds({
        now,
        events: [{ id: 4, deadlineTime: new Date('2026-08-30T12:00:00.000Z') }],
      }),
    ).toEqual([4]);
  });

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

  test('declares semantic recovery finalizers for durable scheduler chains', () => {
    const modes = new Map(
      registry.map((definition) => [definition.name, definition.recoveryCompletionMode]),
    );
    for (const jobName of ['entry-info', 'entry-picks', 'entry-transfers', 'entry-results']) {
      expect(modes.get(jobName)).toBe('entry-scan-finalizer');
    }
    expect(modes.get('tournament-event-results')).toBe('tournament-cascade-finalizer');
    expect(modes.get('understat-team-incremental')).toBe('understat-finalizer');
    expect(modes.get('understat-player-incremental')).toBe('understat-finalizer');
    expect(modes.get('core-snapshot')).toBeUndefined();
  });

  test('serializes post-match stages and lets My FPL reserve every child queue lane', () => {
    const byName = new Map(registry.map((definition) => [definition.name, definition]));
    expect(schedulerExecutionLanes(byName.get('entry-results')!)).toEqual([
      'post-match-results',
      'queue:entry-sync',
    ]);
    expect(schedulerExecutionLanes(byName.get('my-fpl-snapshot')!)).toEqual([
      'post-match-results',
      'queue:data-sync',
      'queue:entry-sync',
      'queue:league-sync',
      'queue:tournament-sync',
    ]);
    expect(schedulerExecutionLanes(byName.get('entry-picks')!)).toEqual(['queue:entry-sync']);

    const postMatchOrder = orderSchedulerDefinitionsForClaim(registry)
      .filter((definition) => definition.executionLanes?.includes('post-match-results'))
      .map((definition) => definition.name);
    expect(postMatchOrder).toEqual([
      'live-finalization',
      'entry-results',
      'tournament-event-results',
      'league-event-results',
      'my-fpl-finalization',
      'my-fpl-snapshot',
    ]);
  });

  test('orders claims by dispatch deadline, criticality, priority and stable name', () => {
    const definitions: ScheduledJobDefinition[] = [
      {
        name: 'market-daily',
        cadence: 'test-only',
        timezone: 'UTC',
        catchUpPolicy: 'none',
        criticality: 'critical',
        queueName: 'data-sync',
        successPredicate: 'test',
        resolve: async () => [],
        enqueue: async () => undefined,
      },
      {
        name: 'tournament-official-h2h-live',
        cadence: 'test-only',
        timezone: 'UTC',
        catchUpPolicy: 'none',
        criticality: 'critical',
        queueName: 'official-h2h-live',
        successPredicate: 'test',
        resolve: async () => [],
        enqueue: async () => undefined,
      },
      {
        name: 'normal-a',
        cadence: 'test-only',
        timezone: 'UTC',
        catchUpPolicy: 'none',
        criticality: 'normal',
        queueName: 'test-only',
        successPredicate: 'test',
        resolve: async () => [],
        enqueue: async () => undefined,
      },
      {
        name: 'critical-b',
        cadence: 'test-only',
        timezone: 'UTC',
        catchUpPolicy: 'none',
        criticality: 'critical',
        queueName: 'test-only',
        successPredicate: 'test',
        resolve: async () => [],
        enqueue: async () => undefined,
      },
      {
        name: 'critical-a',
        cadence: 'test-only',
        timezone: 'UTC',
        catchUpPolicy: 'none',
        criticality: 'critical',
        queueName: 'test-only',
        claimPriority: 10,
        successPredicate: 'test',
        resolve: async () => [],
        enqueue: async () => undefined,
      },
      {
        name: 'deadline-late',
        cadence: 'test-only',
        timezone: 'UTC',
        catchUpPolicy: 'none',
        criticality: 'critical',
        queueName: 'test-only',
        successPredicate: 'test',
        resolve: async () => [],
        enqueue: async () => undefined,
      },
    ];
    const deadlineOrdered = orderSchedulerDefinitionsByEarliestDue(definitions.slice(0, 2), [
      // H2H is due one second later, but its 15-second dispatch budget makes
      // its actual deadline much earlier than market's 10-minute budget.
      { jobName: 'market-daily', earliestDueAt: new Date('2026-08-23T00:00:00.000Z') },
      {
        jobName: 'tournament-official-h2h-live',
        earliestDueAt: new Date('2026-08-23T00:00:01.000Z'),
      },
    ]);
    expect(deadlineOrdered.map((definition) => definition.name)).toEqual([
      'tournament-official-h2h-live',
      'market-daily',
    ]);

    const retryDeadlineOrdered = orderSchedulerDefinitionsByEarliestDue(definitions.slice(0, 2), [
      {
        jobName: 'market-daily',
        // A retry moved mutable due_at past the newer H2H bucket. The
        // immutable schedule must still determine its dispatch deadline.
        earliestDueAt: new Date('2026-08-23T00:20:00.000Z'),
        earliestScheduledDueAt: new Date('2026-08-23T00:00:00.000Z'),
      },
      {
        jobName: 'tournament-official-h2h-live',
        earliestDueAt: new Date('2026-08-23T00:10:00.000Z'),
        earliestScheduledDueAt: new Date('2026-08-23T00:10:00.000Z'),
      },
    ]);
    expect(retryDeadlineOrdered.map((definition) => definition.name)).toEqual([
      'market-daily',
      'tournament-official-h2h-live',
    ]);

    const ordered = orderSchedulerDefinitionsByEarliestDue(definitions.slice(2), [
      // Unknown test definitions have a zero dispatch budget. The equal
      // deadline is resolved by criticality, priority, then stable name.
      { jobName: 'deadline-late', earliestDueAt: new Date('2026-08-23T00:00:01.000Z') },
      { jobName: 'critical-b', earliestDueAt: new Date('2026-08-23T00:00:00.000Z') },
      { jobName: 'normal-a', earliestDueAt: new Date('2026-08-23T00:00:00.000Z') },
      { jobName: 'critical-a', earliestDueAt: new Date('2026-08-23T00:00:00.000Z') },
    ]);
    expect(ordered.map((definition) => definition.name)).toEqual([
      'critical-a',
      'critical-b',
      'normal-a',
      'deadline-late',
    ]);
  });

  test('recomputes due progress from the post-pass candidate set', () => {
    const dueAt = new Date('2026-08-23T00:00:00.000Z');
    const progress = schedulerDueProgress(
      registry,
      [
        { jobName: 'tournament-official-h2h-live', earliestDueAt: dueAt },
        {
          jobName: 'tournament-official-h2h-live',
          earliestDueAt: new Date('2026-08-23T00:00:02.000Z'),
          earliestScheduledDueAt: dueAt,
        },
      ],
      new Date('2026-08-23T00:00:16.000Z'),
    );

    expect(progress).toEqual({
      dueCount: 1,
      lateCount: 1,
      oldestUnfinishedDueAt: dueAt,
    });
    expect(schedulerDueProgress(registry, [], new Date('2026-08-23T00:00:16.000Z'))).toEqual({
      dueCount: 0,
      lateCount: 0,
      oldestUnfinishedDueAt: null,
    });
  });

  test('routes My FPL finalization status and admission to its dedicated lane', () => {
    expect(schedulerQueueLaneOverride('my-fpl-finalization')).toBe('my-fpl-orchestration');
    expect(schedulerQueueLaneOverride('my-fpl-snapshot')).toBeUndefined();
  });

  test('keeps My FPL outbox period identities distinct for governance repair routing', async () => {
    const outbox = registry.find((definition) => definition.name === 'my-fpl-snapshot-outbox');
    expect(outbox).toBeDefined();
    const plans = await outbox!.resolve({
      season: TEST_SEASON,
      now: new Date('2026-08-23T00:07:00.000Z'),
      events: [],
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.periodKey).toMatch(/^outbox-\d+$/);
  });

  test('schedules price changes as a critical five-minute latest-authoritative job', async () => {
    const priceChanges = registry.find(
      (definition) => definition.name === 'price-change-predictions',
    );
    expect(priceChanges).toMatchObject({
      cadence: 'every five minutes at UTC minute 01/06/11...',
      timezone: 'UTC',
      catchUpPolicy: 'latest-authoritative',
      criticality: 'critical',
      queueName: 'fpl-critical-sync',
      manualTrigger: true,
    });
    expect(priceChanges?.executionPolicy).toMatchObject({
      kind: 'single-flight-latest',
      maxTargetsPerDispatch: 2,
    });
    const plans = await priceChanges!.resolve({
      season: TEST_SEASON,
      now: new Date('2026-08-23T00:07:00.000Z'),
      events: [],
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      scopeKey: TEST_SEASON.seasonCode,
      dueAt: new Date('2026-08-23T00:06:00.000Z'),
      source: 'catchup',
      evidence: { cadence: 'five-minute', offsetMs: 60_000 },
    });
  });

  test('opens the dedicated price-change watcher five minutes before deadline', () => {
    const deadline = new Date('2026-08-23T07:00:00.000Z');
    const plans = resolvePriceChangeWatchPlans({
      now: new Date('2026-08-23T06:55:00.000Z'),
      seasonCode: TEST_SEASON.seasonCode,
      deadlineCandidates: [deadline.toISOString()],
    });

    expect(registry.find((definition) => definition.name === 'price-change-watch')).toMatchObject({
      cadence: 'deadline window (5 minutes before each official price-change deadline)',
      queueName: 'fpl-price-watch',
      criticality: 'critical',
    });
    expect(plans).toEqual([
      {
        scopeKey: TEST_SEASON.seasonCode,
        periodKey: `price-change-watch-${deadline.getTime()}`,
        dueAt: new Date('2026-08-23T06:55:00.000Z'),
        source: 'catchup',
        evidence: {
          deadlineAt: deadline.toISOString(),
          leadMs: 5 * 60_000,
          watchWindowMs: 5 * 60_000,
        },
      },
    ]);
  });

  test('treats definitions without an enablement hook as always enabled', () => {
    const priceChanges = registry.find(
      (definition) => definition.name === 'price-change-predictions',
    );
    expect(priceChanges?.isEnabled).toBeUndefined();
    expect(isSchedulerDefinitionEnabled(priceChanges!)).toBe(true);
    expect(isSchedulerDefinitionEnabled({ isEnabled: () => false })).toBe(false);
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
        'client-signal-retention',
        'launch-monitor',
        'post-match-consolidation',
      ]),
    );
    expect(registry.find((definition) => definition.name === 'content-acquisition')).toMatchObject({
      manualTrigger: false,
      queueName: 'content-*',
    });
  });

  test('schedules Understat lanes at staggered UTC+8 incremental checkpoints', async () => {
    const enqueue = mock(async (_input: { seasonCode?: string }) => ({
      id: 'understat-job',
      data: { runId: 'understat-run' },
    }));
    const definition = understatDailyDefinition(
      {
        name: 'understat-team-incremental-test',
        hour: 11,
        minute: 15,
        queueName: 'understat-team-sync',
        successPredicate: 'finalizer',
        enqueue: enqueue as never,
      },
      () => true,
      () => '2526',
    );
    const disabled = understatDailyDefinition(
      {
        name: 'understat-team-incremental-disabled-test',
        hour: 11,
        minute: 15,
        queueName: 'understat-team-sync',
        successPredicate: 'finalizer',
        enqueue: enqueue as never,
      },
      () => false,
    );
    const before = await disabled.resolve({
      season: TEST_SEASON,
      now: new Date('2026-08-23T02:00:00.000Z'),
      events: [],
    });
    expect(before).toEqual([]);
    const plans = await definition.resolve({
      season: TEST_SEASON,
      now: new Date('2026-08-23T04:00:00.000Z'),
      events: [],
    });
    expect(plans).toEqual([
      expect.objectContaining({
        scopeKey: '2526',
        periodKey: '20260823',
        dueAt: new Date('2026-08-23T03:15:00.000Z'),
        source: 'catchup',
      }),
    ]);
    await definition.enqueue({
      context: {
        season: TEST_SEASON,
        now: new Date('2026-08-23T04:00:00.000Z'),
        events: [],
      },
      plan: plans[0]!,
      obligationId: 'understat-obligation',
      generation: 2,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ seasonCode: '2526' });
    expect(definition).toMatchObject({ manualTrigger: false });
    expect(disabled).toMatchObject({ manualTrigger: false });
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

  test('does not await a hung single-flight resolver after its pass budget expires', async () => {
    let release: ((plans: readonly never[]) => void) | undefined;
    let calls = 0;
    const pending = new Promise<readonly never[]>((resolve) => {
      release = resolve;
    });
    const definition: ScheduledJobDefinition = {
      name: 'hung-resolution',
      cadence: 'test-only',
      timezone: 'UTC',
      catchUpPolicy: 'none',
      criticality: 'normal',
      queueName: 'test-only',
      successPredicate: 'never reached',
      resolve: async () => {
        calls += 1;
        return pending;
      },
      enqueue: async () => undefined,
    };
    const context = {
      season: TEST_SEASON,
      now: new Date('2026-08-23T01:00:00.000Z'),
      events: [],
    };

    const first = await Promise.race([
      resolveSchedulerDefinition(definition, context, { timeoutMs: 10 }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    expect(first).not.toBeNull();
    expect(first && 'ok' in first && first.ok).toBe(false);

    const second = await resolveSchedulerDefinition(definition, context, { timeoutMs: 10 });
    expect(second).toMatchObject({ ok: false });
    // The second pass reuses the still-running operation instead of starting
    // a duplicate provider/DB request.
    expect(calls).toBe(1);

    release?.([]);
  });

  test('keeps optional price-watch planning provider-free', () => {
    const schedulerSource = readFileSync('src/scheduler/job-registry.ts', 'utf8');
    expect(schedulerSource).not.toMatch(/from ['"]\.\.\/clients\/fpl['"]/);
    expect(schedulerSource).not.toContain('fplClient.getBootstrap');
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

    fixtures[0]!.finished = true;
    expect(
      await definition.resolve({ ...context, now: new Date('2026-08-24T01:01:00.000Z') }),
    ).toEqual([
      expect.objectContaining({
        periodKey: 'official-h2h-1-202608240101',
        eventId: 1,
        evidence: { lifecycleState: 'GW_REVIEW' },
      }),
    ]);
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
      // 10:00 UTC is already after the 06:55 UTC+8 window on 2026-08-22.
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

  test('reserves the current-day player price replay after the market window', async () => {
    const replay = playerPricesDefinition(async () => ({
      event: { id: 1 } as never,
      phase: 'current' as const,
    }));
    expect(replay).toMatchObject({
      cadence: 'daily',
      timezone: 'Asia/Shanghai',
      catchUpPolicy: 'current-day-only',
      queueName: 'data-sync',
    });

    const plans = await replay!.resolve({
      season: TEST_SEASON,
      now: new Date('2026-08-22T23:20:00.000Z'),
      events: [],
    });
    expect(plans.find((plan) => plan.periodKey === '20260823')).toMatchObject({
      source: 'catchup',
    });
    expect(plans.find((plan) => plan.periodKey === '20260823')?.terminalStatus).toBeUndefined();
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
    expect(today).toBeDefined();
    expect(today?.dueAt).toEqual(new Date('2026-08-22T23:06:00.000Z'));
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

  test('uses durable result authority in the observed-plan LRU key', () => {
    const definition = { name: 'entry-results' };
    const stale = schedulerPlanKey(definition, {
      scopeKey: '2627:event:1',
      periodKey: 'event-1-final-14',
      evidence: {
        resultSlot: 'final-14',
        resultAuthorityAtMs: 1_787_645_600_000,
        resultScheduleAnchorMs: 1_787_638_400_000,
      },
    });
    const fresh = schedulerPlanKey(definition, {
      scopeKey: '2627:event:1',
      periodKey: 'event-1-final-14',
      evidence: {
        resultSlot: 'final-14',
        resultAuthorityAtMs: 1_787_649_200_000,
        resultScheduleAnchorMs: 1_787_638_400_000,
      },
    });

    expect(stale).not.toBe(fresh);
    expect(
      schedulerPlanKey(definition, {
        scopeKey: '2627:event:1',
        periodKey: 'event-1-final',
        evidence: {
          resultSlot: 'final-checkpoint',
          resultAuthorityAtMs: 1_787_645_600_000,
          resultScheduleAnchorMs: 1_787_638_400_000,
        },
      }),
    ).toBe(
      schedulerPlanKey(definition, {
        scopeKey: '2627:event:1',
        periodKey: 'event-1-final',
        evidence: {
          resultSlot: 'final-checkpoint',
          resultAuthorityAtMs: 1_787_649_200_000,
          resultScheduleAnchorMs: 1_787_642_000_000,
        },
      }),
    );
  });

  test('keeps a corrected post-match plan retryable until its authority is persisted', () => {
    const plan = {
      evidence: {
        resultSlot: 'final-14',
        resultAuthorityAtMs: 1_787_649_200_000,
        resultScheduleAnchorMs: 1_787_642_000_000,
      },
    };
    expect(
      postMatchReservationWasPersisted(plan, {
        evidence: {
          resultSlot: 'final-14',
          resultAuthorityAtMs: 1_787_645_600_000,
          resultScheduleAnchorMs: 1_787_638_400_000,
        },
      }),
    ).toBe(false);
    expect(postMatchReservationWasPersisted(plan, { evidence: plan.evidence })).toBe(true);
    expect(
      postMatchReservationWasPersisted(
        {
          evidence: {
            resultSlot: 'final-checkpoint',
            resultAuthorityAtMs: 1_787_649_200_000,
            resultScheduleAnchorMs: 1_787_642_000_000,
          },
        },
        { evidence: {} },
      ),
    ).toBe(true);
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
    const authorityAt = new Date('2026-08-22T19:59:30.000Z');
    const fixtures = [
      {
        ...mockFixture1,
        kickoffTime: new Date('2026-08-22T18:00:00.000Z'),
        updatedAt: authorityAt,
      },
    ];
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
        dueAt: new Date('2026-08-22T20:00:00.000Z'),
        eventId: 1,
        source: 'reconcile',
        evidence: expect.objectContaining({
          resultAuthorityAtMs: authorityAt.getTime(),
          resultScheduleAnchorMs: Date.parse('2026-08-22T18:00:00.000Z'),
        }),
      }),
    ]);
  });

  test('keeps provisional and incomplete-final result slots in the base planner', async () => {
    const checkedAt = new Date('2026-08-22T22:00:00.000Z');
    const plans = await resolvePostMatchResultPlans(
      {
        season: TEST_SEASON,
        now: new Date('2026-08-23T12:00:00.000Z'),
        events: [
          {
            id: 1,
            deadlineTime: new Date('2026-08-22T17:30:00.000Z'),
            finished: true,
            dataChecked: true,
            dataCheckedAt: checkedAt,
          },
          {
            id: 2,
            deadlineTime: new Date('2026-08-22T17:30:00.000Z'),
            finished: true,
            dataChecked: true,
            dataCheckedAt: null,
          },
          {
            id: 3,
            deadlineTime: new Date('2026-08-22T17:30:00.000Z'),
            finished: false,
            dataChecked: false,
            dataCheckedAt: null,
          },
        ],
      },
      async (season, eventId) => {
        expect(season).toEqual(TEST_SEASON);
        expect([2, 3]).toContain(eventId);
        return [
          {
            ...mockFixture1,
            event: eventId,
            kickoffTime: new Date('2026-08-22T18:00:00.000Z'),
          },
        ];
      },
    );

    expect(plans.map((plan) => plan.periodKey)).toEqual([
      'event-1-final',
      'event-2-provisional-16',
      'event-3-provisional-16',
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

  test('keeps V2 finalization catch-up independent from the current event', () => {
    const checkedAt = new Date('2026-08-22T22:00:00.000Z');
    const plans = resolveLiveFinalizationCatchupPlans(
      {
        season: TEST_SEASON,
        now: new Date('2026-08-25T12:00:00.000Z'),
        currentEventId: 4,
        events: [
          {
            id: 2,
            deadlineTime: new Date('2026-08-22T17:30:00.000Z'),
            finished: true,
            dataChecked: true,
            dataCheckedAt: checkedAt,
          },
          {
            id: 4,
            deadlineTime: new Date('2026-08-25T17:30:00.000Z'),
            finished: false,
            dataChecked: false,
            dataCheckedAt: null,
          },
          {
            id: 3,
            deadlineTime: new Date('2026-08-24T17:30:00.000Z'),
            finished: true,
            dataChecked: true,
            dataCheckedAt: null,
          },
        ],
      },
      new Set([2, 3]),
    );

    expect(plans).toEqual([
      expect.objectContaining({
        eventId: 2,
        dueAt: checkedAt,
        source: 'catchup',
        periodKey: `live-final-catchup-2-${checkedAt.getTime()}`,
        evidence: expect.objectContaining({
          finalization: 'missing-v2-checkpoint',
          resultSlot: 'final-checkpoint',
          resultAuthorityAtMs: checkedAt.getTime(),
          resultScheduleAnchorMs: checkedAt.getTime(),
          finalizeEvent: true,
        }),
      }),
    ]);
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
