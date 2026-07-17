import { afterAll, describe, expect, test } from 'bun:test';

import { closeLockClient, withMutationConflictGuard } from '../../src/utils/mutation-lock';

afterAll(async () => {
  await closeLockClient();
});

type GuardRun = {
  label: string;
  start: number;
  end: number;
};

async function runGuarded(
  label: string,
  input: Parameters<typeof withMutationConflictGuard>[0],
  holdMs: number,
  runs: GuardRun[],
): Promise<void> {
  await withMutationConflictGuard(input, async () => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    runs.push({ label, start, end: Date.now() });
  });
}

describe('mutation lock serialization (FP-07)', () => {
  test(
    'tournament setup and battle-race results never run concurrently (C4)',
    async () => {
      const runs: GuardRun[] = [];
      await Promise.all([
        runGuarded(
          'setup',
          { queueName: 'tournament-setup', jobName: 'tournament-setup', tournamentId: 999001 },
          400,
          runs,
        ),
        runGuarded(
          'battle-race',
          { queueName: 'tournament-sync', jobName: 'tournament-battle-race', eventId: 33 },
          400,
          runs,
        ),
      ]);

      expect(runs).toHaveLength(2);
      const [first, second] = [...runs].sort((a, b) => a.start - b.start);
      // Whichever acquired the shared structure scope first fully finished
      // before the other was allowed in.
      expect(second.start).toBeGreaterThanOrEqual(first.end);
    },
    { timeout: 30_000 },
  );

  test(
    'results jobs on different events serialize on the shared scope',
    async () => {
      const runs: GuardRun[] = [];
      await Promise.all([
        runGuarded(
          'points-race-gw33',
          { queueName: 'tournament-sync', jobName: 'tournament-points-race', eventId: 33 },
          300,
          runs,
        ),
        runGuarded(
          'knockout-gw34',
          { queueName: 'tournament-sync', jobName: 'tournament-knockout', eventId: 34 },
          300,
          runs,
        ),
      ]);

      expect(runs).toHaveLength(2);
      const [first, second] = [...runs].sort((a, b) => a.start - b.start);
      expect(second.start).toBeGreaterThanOrEqual(first.end);
    },
    { timeout: 30_000 },
  );
});
