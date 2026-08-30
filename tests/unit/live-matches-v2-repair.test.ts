import { describe, expect, test } from 'bun:test';

import {
  assertLiveMatchesRepairAuthorization,
  parseLiveMatchesRepairArguments,
} from '../../scripts/repair-live-matches-v2';

describe('Live Matches V2 repair guardrails', () => {
  test('parses an exact read-only scope without write authorization', () => {
    expect(
      parseLiveMatchesRepairArguments([
        '--action',
        'inspect',
        '--season',
        '2627',
        '--event-id',
        '2',
      ]),
    ).toEqual({
      action: 'inspect',
      season: '2627',
      eventId: 2,
      kind: null,
      reason: null,
    });
    expect(() => assertLiveMatchesRepairAuthorization('inspect', {})).not.toThrow();
  });

  test('requires kind, reason, and explicit environment confirmation for writes', () => {
    expect(() =>
      parseLiveMatchesRepairArguments([
        '--action',
        'rebuild-current',
        '--season',
        '2627',
        '--event-id',
        '2',
        '--reason',
        'checkpoint recovery',
      ]),
    ).toThrow('exact --kind');
    expect(() =>
      parseLiveMatchesRepairArguments([
        '--action',
        'rebuild-current',
        '--season',
        '2627',
        '--event-id',
        '2',
        '--kind',
        'desk',
        '--reason',
        'short',
      ]),
    ).toThrow('at least 12 characters');
    expect(() => assertLiveMatchesRepairAuthorization('rebuild-current', {})).toThrow(
      'LIVE_MATCHES_REPAIR_CONFIRM=YES',
    );
    expect(() =>
      assertLiveMatchesRepairAuthorization('rebuild-current', {
        LIVE_MATCHES_REPAIR_CONFIRM: 'YES',
      }),
    ).not.toThrow();
  });

  test('rejects duplicate and unknown arguments instead of widening scope', () => {
    expect(() =>
      parseLiveMatchesRepairArguments([
        '--action=inspect',
        '--season=2627',
        '--event-id=2',
        '--event-id=3',
      ]),
    ).toThrow('duplicate repair argument --event-id');
    expect(() =>
      parseLiveMatchesRepairArguments([
        '--action=inspect',
        '--season=2627',
        '--event-id=2',
        '--all-events=yes',
      ]),
    ).toThrow('unsupported repair argument --all-events');
  });
});
