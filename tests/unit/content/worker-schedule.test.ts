import { describe, expect, test } from 'bun:test';

import { computePollWindow, isPollDue, resolvePollPhase } from '../../../src/content/poll-policy';

const now = new Date('2026-08-20T10:00:00.000Z');

describe('content worker poll policy', () => {
  test('keeps FINAL_90 disabled unless a future duty window and budget are recorded', () => {
    const deadlineAt = '2026-08-20T11:00:00.000Z';
    const base = { deadlineAt, final90Enabled: true, final90Budget: 2 };
    expect(resolvePollPhase(base, now)).toBe('APPROACHING');
    expect(resolvePollPhase({ ...base, editorOnDutyUntil: '2026-08-20T10:30:00.000Z' }, now)).toBe(
      'FINAL_90',
    );
  });

  test('uses safety lag, overlap and a bounded catch-up window', () => {
    const window = computePollWindow({
      policy: { safetyLagMinutes: 2, overlapMinutes: 5, maxCatchupMinutes: 60 },
      phase: 'NORMAL',
      now,
      checkpointEnd: new Date('2026-08-20T06:00:00.000Z'),
    });
    expect(window.windowEnd.toISOString()).toBe('2026-08-20T09:58:00.000Z');
    expect(window.windowStart.toISOString()).toBe('2026-08-20T08:58:00.000Z');
  });

  test('does not enqueue again before the phase-specific cadence elapses', () => {
    const checkpointEnd = new Date('2026-08-20T09:45:00.000Z');
    const policy = { normalMinutes: 30, approachingMinutes: 10 };
    expect(isPollDue({ policy, phase: 'NORMAL', now, checkpointEnd })).toBe(false);
    expect(
      isPollDue({
        policy,
        phase: 'NORMAL',
        now: new Date('2026-08-20T10:15:00.000Z'),
        checkpointEnd,
      }),
    ).toBe(true);
    expect(isPollDue({ policy, phase: 'APPROACHING', now, checkpointEnd })).toBe(true);
  });
});
