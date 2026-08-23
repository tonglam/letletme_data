import { describe, expect, mock, test } from 'bun:test';

import { createSchedulerRegistry, officialH2HDefinition } from '../../src/scheduler/job-registry';
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
    const enqueue = mock(async () => ({ id: 'official-job', data: { runId: 'official-run' } }));
    const definition = officialH2HDefinition({
      findEvent: async () => event,
      findFixtures: async () => fixtures,
      enqueue: enqueue as never,
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
