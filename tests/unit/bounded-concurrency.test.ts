import { describe, expect, test } from 'bun:test';

import { leagueChildJobId } from '../../src/domain/league-sync';
import { mapWithConcurrency } from '../../src/utils/async';

describe('bounded fan-out', () => {
  test('never exceeds the requested concurrency across a large work list', async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapWithConcurrency(
      Array.from({ length: 250 }, (_, index) => index),
      10,
      async (value) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
        return value;
      },
    );

    expect(result).toHaveLength(250);
    expect(maximum).toBeLessThanOrEqual(10);
  });

  test('keeps child job IDs stable within a coordinator run and distinct across runs', () => {
    const first = leagueChildJobId('league-event-results', 12, 99, 'coordinator-run-1');
    expect(leagueChildJobId('league-event-results', 12, 99, 'coordinator-run-1')).toBe(first);
    expect(leagueChildJobId('league-event-results', 12, 99, 'coordinator-run-2')).not.toBe(first);
    expect(leagueChildJobId('league-event-results', 12, 100, 'coordinator-run-1')).not.toBe(first);
  });
});
