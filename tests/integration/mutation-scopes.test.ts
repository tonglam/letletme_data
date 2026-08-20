import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { describe, expect, test } from 'bun:test';

import { tournamentSetupRebuildScopes } from '../../src/domain/mutation-scope';
import { withMutationScopes } from '../../src/utils/mutation-scopes';

type ScopeRun = {
  label: string;
  start: number;
  end: number;
};

async function runScoped(
  label: string,
  input: Parameters<typeof withMutationScopes>[0],
  holdMs: number,
  runs: ScopeRun[],
): Promise<void> {
  await withMutationScopes(input, async () => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    runs.push({ label, start, end: Date.now() });
  });
}

describe('mutation scope serialization (FP-07)', () => {
  test(
    'tournament setup and battle-race results never run concurrently (C4)',
    async () => {
      const runs: ScopeRun[] = [];
      await Promise.all([
        runScoped(
          'setup-rebuild',
          {
            queueName: 'tournament-setup',
            jobName: 'tournament-setup',
            tournamentId: 999001,
            // Explicit rebuild scopes (setup job defaults are empty so FPL sync
            // is not covered by the global structure lock).
            scopes: tournamentSetupRebuildScopes(999001),
          },
          400,
          runs,
        ),
        runScoped(
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
      const runs: ScopeRun[] = [];
      await Promise.all([
        runScoped(
          'points-race-gw33',
          { queueName: 'tournament-sync', jobName: 'tournament-points-race', eventId: 33 },
          300,
          runs,
        ),
        runScoped(
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
