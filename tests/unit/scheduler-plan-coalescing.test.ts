import { describe, expect, test } from 'bun:test';

import type { SchedulerObligationPlan } from '../../src/scheduler/job-registry';
import { latestActiveSchedulerPlansByScope } from '../../src/scheduler/plan-coalescing';

const plan = (
  scopeKey: string,
  periodKey: string,
  dueAt: string,
  terminalStatus?: SchedulerObligationPlan['terminalStatus'],
): SchedulerObligationPlan => ({
  scopeKey,
  periodKey,
  dueAt: new Date(dueAt),
  source: 'reconcile',
  terminalStatus,
});

describe('scheduler plan coalescing', () => {
  test('selects the newest active checkpoint independently for every scope', () => {
    const latest = latestActiveSchedulerPlansByScope([
      plan('2627:event:2', 'event-2-provisional-3', '2026-08-25T10:00:00Z'),
      plan('2627:event:1', 'event-1-provisional-12', '2026-08-25T09:00:00Z'),
      plan('2627:event:1', 'event-1-provisional-15', '2026-08-25T12:00:00Z'),
      plan('2627:event:2', 'event-2-final', '2026-08-25T11:00:00Z'),
    ]);

    expect(latest.map(({ scopeKey, periodKey }) => ({ scopeKey, periodKey }))).toEqual([
      { scopeKey: '2627:event:1', periodKey: 'event-1-provisional-15' },
      { scopeKey: '2627:event:2', periodKey: 'event-2-final' },
    ]);
  });

  test('ignores terminal plans when choosing a supersession boundary', () => {
    const latest = latestActiveSchedulerPlansByScope([
      plan('2627:event:1', 'event-1-provisional-15', '2026-08-25T12:00:00Z'),
      plan('2627:event:1', 'event-1-expired', '2026-08-25T13:00:00Z', 'irrecoverable'),
    ]);

    expect(latest).toHaveLength(1);
    expect(latest[0]?.periodKey).toBe('event-1-provisional-15');
  });
});
