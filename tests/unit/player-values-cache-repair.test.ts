import { describe, expect, test } from 'bun:test';

import type { PlayerValue } from '../../src/domain/player-values';
import { planPlayerValueCacheRepairs } from '../../src/services/player-values.service';

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
    expect(
      planPlayerValueCacheRepairs([value], {
        fields: ['1'],
        entries: [['1', { ...value }]],
      }),
    ).toEqual({ writes: [], staleFields: [] });
  });

  test('repairs missing or stale persisted fields with HSET candidates', () => {
    expect(planPlayerValueCacheRepairs([value], { fields: [], entries: [] })).toEqual({
      writes: [value],
      staleFields: [],
    });
    expect(
      planPlayerValueCacheRepairs([value], {
        fields: ['1'],
        entries: [['1', { ...value, lastValue: 50 }]],
      }),
    ).toEqual({ writes: [value], staleFields: [] });
  });

  test('repairs stale enrichment fields as part of the complete cached shape', () => {
    const staleValues: PlayerValue[] = [
      { ...value, webName: 'Old Player' },
      { ...value, elementTypeName: 'FWD' },
      { ...value, teamId: 2 },
      { ...value, teamName: 'Old Team' },
      { ...value, teamShortName: 'OLD' },
    ];

    for (const staleValue of staleValues) {
      expect(
        planPlayerValueCacheRepairs([value], {
          fields: ['1'],
          entries: [['1', staleValue]],
        }),
      ).toEqual({ writes: [value], staleFields: [] });
    }
  });

  test('repairs the canonical field and removes extra or mis-keyed fields', () => {
    expect(
      planPlayerValueCacheRepairs([value], {
        fields: ['wrong-field', '999'],
        entries: [
          ['wrong-field', value],
          ['999', { ...value, elementId: 999 }],
        ],
      }),
    ).toEqual({ writes: [value], staleFields: ['wrong-field', '999'] });
  });

  test('overwrites a corrupt expected field without deleting its hash field', () => {
    expect(
      planPlayerValueCacheRepairs([value], {
        fields: ['1'],
        entries: [],
      }),
    ).toEqual({ writes: [value], staleFields: [] });
  });
});
