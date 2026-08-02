import { describe, expect, test } from 'bun:test';

import type { PlayerValue } from '../../src/domain/player-values';
import { findPlayerValueCacheRepairs } from '../../src/services/player-values.service';

const value: PlayerValue = {
  elementId: 1,
  webName: 'Player',
  elementType: 3,
  elementTypeName: 'MID',
  eventId: 1,
  teamId: 1,
  teamName: 'Team',
  teamShortName: 'TEA',
  value: 50,
  changeDate: '20260802',
  changeType: 'Start',
  lastValue: 0,
};

describe('player-values cache repair selection', () => {
  test('does not rewrite a complete no-change cache', () => {
    expect(findPlayerValueCacheRepairs([value], [{ ...value }])).toEqual([]);
  });

  test('repairs missing or stale persisted fields with HSET candidates', () => {
    expect(findPlayerValueCacheRepairs([value], null)).toEqual([value]);
    expect(findPlayerValueCacheRepairs([value], [{ ...value, lastValue: 50 }])).toEqual([value]);
  });
});
