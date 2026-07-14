import { describe, expect, test } from 'bun:test';

import {
  deriveSeasonFromEvents,
  deriveSeasonFromFixtures,
  isNewerSeason,
  seasonFromStartYear,
} from '../../src/cache/cache-season';
import { mockRawFPLFixture1 } from '../fixtures/fixtures.fixtures';
import { singleRawEventFixture } from '../fixtures/events.fixtures';

describe('cache season resolver', () => {
  test('derives season from GW1 deadline year', () => {
    expect(
      deriveSeasonFromEvents([
        {
          ...singleRawEventFixture,
          id: 1,
          deadline_time: '2025-08-15T17:30:00Z',
        },
      ]),
    ).toBe('2526');

    expect(
      deriveSeasonFromEvents([
        {
          ...singleRawEventFixture,
          id: 1,
          deadline_time: '2026-08-14T17:30:00Z',
        },
      ]),
    ).toBe('2627');
  });

  test('does not infer new season from old-season GW38 in the next calendar year', () => {
    expect(
      deriveSeasonFromEvents([
        {
          ...singleRawEventFixture,
          id: 38,
          deadline_time: '2026-05-24T13:30:00Z',
        },
      ]),
    ).toBeNull();
  });

  test('falls back to GW1 fixture kickoff year', () => {
    expect(
      deriveSeasonFromFixtures([
        {
          ...mockRawFPLFixture1,
          event: 1,
          kickoff_time: '2026-08-14T19:00:00Z',
        },
      ]),
    ).toBe('2627');
  });

  test('ignores non-GW1 fixture kickoff years', () => {
    expect(
      deriveSeasonFromFixtures([
        {
          ...mockRawFPLFixture1,
          event: 38,
          kickoff_time: '2026-05-24T15:00:00Z',
        },
      ]),
    ).toBeNull();
  });

  test('compares season keys numerically', () => {
    expect(seasonFromStartYear(2026)).toBe('2627');
    expect(isNewerSeason('2627', '2526')).toBe(true);
    expect(isNewerSeason('2526', '2627')).toBe(false);
  });
});
