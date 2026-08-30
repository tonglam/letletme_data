import { describe, expect, test } from 'bun:test';

import {
  assertRepairAuthorization,
  parseRepairArguments,
  resolveRepairFinalization,
} from '../../scripts/repair-live-points-v2';

describe('Live Points V2 repair guard', () => {
  test('requires an exact scope and a reason for writes', () => {
    expect(
      parseRepairArguments([
        '--action',
        'promote-previous',
        '--season',
        '2627',
        '--event-id',
        '2',
        '--reason',
        'restore the last complete publication',
      ]),
    ).toEqual({
      action: 'promote-previous',
      season: '2627',
      eventId: 2,
      reason: 'restore the last complete publication',
    });
    expect(() =>
      parseRepairArguments([
        '--action',
        'replay-checkpoint',
        '--season',
        '2627',
        '--event-id',
        '2',
      ]),
    ).toThrow('reason');
  });

  test('never authorizes a write implicitly', () => {
    expect(() => assertRepairAuthorization('rebuild-current', {})).toThrow(
      'LIVE_POINTS_REPAIR_CONFIRM',
    );
    expect(() =>
      assertRepairAuthorization('rebuild-current', { LIVE_POINTS_REPAIR_CONFIRM: 'YES' }),
    ).not.toThrow();
    expect(() => assertRepairAuthorization('inspect', {})).not.toThrow();
  });

  test('preserves the exact finalized event boundary during replay', () => {
    expect(
      resolveRepairFinalization({
        finished: true,
        dataChecked: true,
        dataCheckedAt: new Date('2026-08-30T12:00:00.000Z'),
      }),
    ).toBe(true);
    expect(
      resolveRepairFinalization({ finished: false, dataChecked: false, dataCheckedAt: null }),
    ).toBe(false);
    expect(() =>
      resolveRepairFinalization({ finished: true, dataChecked: true, dataCheckedAt: null }),
    ).toThrow('exact data_checked timestamp');
  });
});
