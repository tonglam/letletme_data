import { describe, expect, test } from 'bun:test';

import {
  deriveManagerLiveTournamentCoverageState,
  invalidateManagerLiveTournamentCoverage,
  tournamentRosterRevision,
} from '../../src/services/manager-live.service';

describe('manager live tournament coverage state', () => {
  test('only marks a crawl COMPLETE when every roster row resolved without an error', () => {
    expect(
      deriveManagerLiveTournamentCoverageState({
        expectedEntries: 1_567,
        resolvedEntries: 1_567,
        errorCode: null,
        crawlComplete: true,
      }),
    ).toBe('COMPLETE');

    for (const input of [
      { resolvedEntries: 1_566, errorCode: null, crawlComplete: true },
      { resolvedEntries: 1_567, errorCode: 'UPSTREAM_UNAVAILABLE' as const, crawlComplete: true },
      { resolvedEntries: 1_567, errorCode: null, crawlComplete: false },
    ]) {
      expect(
        deriveManagerLiveTournamentCoverageState({
          expectedEntries: 1_567,
          ...input,
        }),
      ).not.toBe('COMPLETE');
    }
  });

  test('distinguishes warming from partial and unavailable progress', () => {
    expect(
      deriveManagerLiveTournamentCoverageState({
        expectedEntries: 500,
        resolvedEntries: 0,
        errorCode: null,
        crawlComplete: false,
      }),
    ).toBe('WARMING');
    expect(
      deriveManagerLiveTournamentCoverageState({
        expectedEntries: 500,
        resolvedEntries: 64,
        errorCode: null,
        crawlComplete: false,
      }),
    ).toBe('PARTIAL');
    expect(
      deriveManagerLiveTournamentCoverageState({
        expectedEntries: 500,
        resolvedEntries: 0,
        errorCode: 'UPSTREAM_RATE_LIMITED',
        crawlComplete: false,
      }),
    ).toBe('UNAVAILABLE');
  });

  test('uses one deterministic revision and changes it when the roster changes', () => {
    expect(tournamentRosterRevision([3, 1, 2])).toBe(tournamentRosterRevision([1, 2, 3]));
    expect(tournamentRosterRevision([1, 2, 3])).not.toBe(tournamentRosterRevision([1, 2, 4]));
  });

  test('invalidates a published coverage row when the roster revision changes', () => {
    const previous = {
      rosterRevision: 'old-roster',
      expectedEntries: 2,
      resolvedEntries: 2,
      fullyFetchedAt: '2026-08-25T00:00:00.000Z',
      managerRevision: 'old-manager',
      error: null,
      state: 'COMPLETE' as const,
    };
    expect(invalidateManagerLiveTournamentCoverage(previous, 'new-roster', 3)).toEqual({
      ...previous,
      rosterRevision: 'new-roster',
      expectedEntries: 3,
      resolvedEntries: 0,
      fullyFetchedAt: null,
      managerRevision: null,
      state: 'WARMING',
    });
    expect(invalidateManagerLiveTournamentCoverage(previous, 'old-roster', 2)).toBe(previous);
  });
});
