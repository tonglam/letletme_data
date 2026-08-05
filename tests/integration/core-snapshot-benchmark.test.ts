import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { describe, expect, test } from 'bun:test';
import { performance } from 'node:perf_hooks';

import {
  syncCoreSnapshot,
  type CoreSnapshotMilestone,
} from '../../src/services/core-snapshot.service';
import { buildCoreSnapshotFixture } from '../fixtures/core-snapshot.fixtures';

const describeBenchmark =
  process.env.RUN_CORE_SNAPSHOT_BENCHMARK === '1' ? describe : describe.skip;

describeBenchmark('core snapshot deterministic benchmark', () => {
  test('validates the complete snapshot with one bootstrap and one fixtures request', async () => {
    const input = buildCoreSnapshotFixture({ playerCount: 700 });
    const milestones: CoreSnapshotMilestone[] = [];
    let bootstrapCalls = 0;
    let fixtureCalls = 0;
    const rssBefore = process.memoryUsage().rss;
    const startedAt = performance.now();

    const result = await syncCoreSnapshot({
      getBootstrap: async () => {
        bootstrapCalls += 1;
        return input.bootstrap;
      },
      getFixtures: async () => {
        fixtureCalls += 1;
        return input.fixtures;
      },
      getActiveSeason: async () => '2627',
      readOrderingTimestamp: async () => new Date('2026-08-04T00:00:00.000Z'),
      reserveRevision: async () => 1,
      createPublicationId: () => '00000000-0000-4000-8000-000000000001',
      recoverPending: async () => undefined,
      commit: async () => ({ status: 'committed' }),
      cleanup: async () => undefined,
      withPersistenceLock: async (operation) => operation(),
      onMilestone: (milestone) => milestones.push(milestone),
    });

    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const rssDeltaBytes = process.memoryUsage().rss - rssBefore;
    const report = {
      event: 'core_snapshot_benchmark',
      schemaVersion: 1,
      events: result.events,
      teams: result.teams,
      players: result.players,
      phases: result.phases,
      fixtures: result.fixtures,
      durationMs,
      rssDeltaBytes,
      milestoneOrder: milestones,
      requests: { bootstrap: bootstrapCalls, fixtures: fixtureCalls, total: 2 },
      requiredUnits: result.requiredUnits,
      reusedUnits: result.reusedUnits,
    };
    console.error(JSON.stringify(report));

    expect(result.outcome).toBe('ready');
    expect(bootstrapCalls).toBe(1);
    expect(fixtureCalls).toBe(1);
    expect(milestones).toEqual(['fetched', 'validated', 'locked', 'persisted', 'published']);
    expect(result).toMatchObject({ events: 38, teams: 20, players: 700, phases: 1, fixtures: 380 });
    expect(Number.isFinite(durationMs)).toBe(true);
    expect(Number.isFinite(rssDeltaBytes)).toBe(true);
  });
});
