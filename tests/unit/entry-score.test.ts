import { describe, expect, test } from 'bun:test';

import { resolveEntryScoreBaseline } from '../../src/domain/entry-score';

describe('resolveEntryScoreBaseline', () => {
  test('uses the provider-derived baseline for a consistent history payload', () => {
    expect(
      resolveEntryScoreBaseline({
        sourceTotalPoints: 57,
        sourceEventPoints: 29,
        eventTransfersCost: 2,
      }),
    ).toEqual({
      previousOverallPoints: 30,
      sourcePreviousOverallPoints: 30,
      usedPersistedFallback: false,
    });
  });

  test('uses the last persisted total when the provider returns a negative baseline', () => {
    expect(
      resolveEntryScoreBaseline({
        sourceTotalPoints: 0,
        sourceEventPoints: 29,
        eventTransfersCost: 0,
        persistedPreviousOverallPoints: 4,
      }),
    ).toEqual({
      previousOverallPoints: 4,
      sourcePreviousOverallPoints: -29,
      usedPersistedFallback: true,
    });
  });

  test('uses zero for a first event without a persisted baseline', () => {
    expect(
      resolveEntryScoreBaseline({
        sourceTotalPoints: 0,
        sourceEventPoints: 29,
        eventTransfersCost: 0,
      }),
    ).toEqual({
      previousOverallPoints: 0,
      sourcePreviousOverallPoints: -29,
      usedPersistedFallback: true,
    });
  });

  test('does not accept a negative persisted baseline as evidence', () => {
    expect(
      resolveEntryScoreBaseline({
        sourceTotalPoints: 0,
        sourceEventPoints: 29,
        eventTransfersCost: 0,
        persistedPreviousOverallPoints: -1,
      }).previousOverallPoints,
    ).toBe(0);
  });
});
