import { describe, expect, test } from 'bun:test';

import { buildCoreSnapshotCachePlan } from '../../src/cache/core-snapshot-cache';
import {
  CORE_SNAPSHOT_MIN_PLAYERS_PER_TEAM,
  prepareCoreSnapshot,
} from '../../src/domain/core-snapshot';
import { CacheError } from '../../src/utils/errors';
import {
  syncCoreSnapshot,
  type CoreSnapshotDependencies,
  type CoreSnapshotMilestone,
} from '../../src/services/core-snapshot.service';
import { buildCoreSnapshotFixture } from '../fixtures/core-snapshot.fixtures';

describe('core snapshot validation', () => {
  test('accepts one complete 38/20/players/phases/380 snapshot', () => {
    const input = buildCoreSnapshotFixture();
    const snapshot = prepareCoreSnapshot(input.bootstrap, input.fixtures);

    expect(snapshot.season).toBe('2627');
    expect(snapshot.events).toHaveLength(38);
    expect(snapshot.teams).toHaveLength(20);
    expect(snapshot.players).toHaveLength(220);
    expect(snapshot.phases).toHaveLength(1);
    expect(snapshot.fixtures).toHaveLength(380);

    const plan = buildCoreSnapshotCachePlan(snapshot);
    expect(plan.hashes.get('Event:2627')).toHaveProperty('38');
    expect(plan.hashes.get('Team:2627')).toHaveProperty('20');
    expect(plan.hashes.get('Player:2627')).toHaveProperty('220');
    expect([...plan.hashes.keys()].filter((key) => key.startsWith('Fixtures:2627:'))).toHaveLength(
      38,
    );
    expect(
      [...plan.hashes.keys()].filter((key) => key.startsWith('FixturesByTeam:2627:')),
    ).toHaveLength(20);
  });

  test('rejects incomplete counts, duplicate identifiers, and broken references', () => {
    const missingEvent = buildCoreSnapshotFixture();
    missingEvent.bootstrap.events.pop();
    expect(() => prepareCoreSnapshot(missingEvent.bootstrap, missingEvent.fixtures)).toThrow(
      'events count',
    );

    const duplicatePlayer = buildCoreSnapshotFixture();
    duplicatePlayer.bootstrap.elements[1] = {
      ...duplicatePlayer.bootstrap.elements[1],
      id: duplicatePlayer.bootstrap.elements[0].id,
    };
    expect(() => prepareCoreSnapshot(duplicatePlayer.bootstrap, duplicatePlayer.fixtures)).toThrow(
      'player identifiers',
    );

    const badFixture = buildCoreSnapshotFixture();
    badFixture.fixtures[0] = { ...badFixture.fixtures[0], team_h: 99 };
    expect(() => prepareCoreSnapshot(badFixture.bootstrap, badFixture.fixtures)).toThrow(
      'unknown team',
    );

    const missingTeamPlayer = buildCoreSnapshotFixture();
    missingTeamPlayer.bootstrap.elements = missingTeamPlayer.bootstrap.elements.filter(
      (player, index) => player.team !== 20 || index === 19,
    );
    expect(() =>
      prepareCoreSnapshot(missingTeamPlayer.bootstrap, missingTeamPlayer.fixtures),
    ).toThrow('player team roster');

    const mismatchedSeason = buildCoreSnapshotFixture();
    mismatchedSeason.fixtures = mismatchedSeason.fixtures.map((fixture) => ({
      ...fixture,
      kickoff_time: fixture.event === 1 ? '2027-08-15T14:00:00.000Z' : fixture.kickoff_time,
    }));
    expect(() =>
      prepareCoreSnapshot(mismatchedSeason.bootstrap, mismatchedSeason.fixtures),
    ).toThrow('event and fixture seasons disagree');

    const repeatedPairings = buildCoreSnapshotFixture();
    repeatedPairings.fixtures.splice(
      10,
      10,
      ...repeatedPairings.fixtures.slice(0, 10).map((fixture, index) => ({
        ...fixture,
        id: 11 + index,
        code: 30_011 + index,
        event: 2,
      })),
    );
    expect(() =>
      prepareCoreSnapshot(repeatedPairings.bootstrap, repeatedPairings.fixtures),
    ).toThrow('home-and-away pairing');
  });

  test('requires a conservative starting-XI roster floor for every team', () => {
    const truncated = buildCoreSnapshotFixture({ playerCount: 20 });
    expect(() => prepareCoreSnapshot(truncated.bootstrap, truncated.fixtures)).toThrow(
      'player team roster is incomplete',
    );

    const minimumComplete = buildCoreSnapshotFixture({
      playerCount: CORE_SNAPSHOT_MIN_PLAYERS_PER_TEAM * 20,
    });
    expect(() =>
      prepareCoreSnapshot(minimumComplete.bootstrap, minimumComplete.fixtures),
    ).not.toThrow();
  });

  test('retains valid unassigned fixtures in the cache snapshot', () => {
    const input = buildCoreSnapshotFixture();
    input.fixtures[0] = { ...input.fixtures[0], event: null };

    const snapshot = prepareCoreSnapshot(input.bootstrap, input.fixtures);
    const plan = buildCoreSnapshotCachePlan(snapshot);

    expect(snapshot.fixtures[0].event).toBeNull();
    expect(plan.hashes.get('Fixtures:2627:unscheduled')).toHaveProperty(
      String(snapshot.fixtures[0].id),
    );
  });
});

describe('core snapshot synchronization', () => {
  function dependencies(options?: {
    activeSeason?: string | null;
    activeSeasons?: (string | null)[];
    persist?: () => Promise<unknown>;
    publish?: () => Promise<{ published: boolean }>;
    cleanup?: () => Promise<void>;
    calls?: string[];
    milestones?: CoreSnapshotMilestone[];
  }): CoreSnapshotDependencies {
    const input = buildCoreSnapshotFixture();
    const calls = options?.calls ?? [];
    let activeSeasonReads = 0;
    return {
      getBootstrap: async () => {
        calls.push('bootstrap');
        return input.bootstrap;
      },
      getFixtures: async () => {
        calls.push('fixtures');
        return input.fixtures;
      },
      getActiveSeason: async () => {
        const sequence = options?.activeSeasons;
        if (sequence && activeSeasonReads < sequence.length) {
          return sequence[activeSeasonReads++];
        }
        activeSeasonReads += 1;
        return options?.activeSeason ?? '2627';
      },
      readOrderingTimestamp: async () => {
        calls.push('ordering-timestamp');
        return new Date('2026-08-04T00:00:00.000Z');
      },
      reserveRevision: async () => 1,
      createPublicationId: () => '00000000-0000-4000-8000-000000000001',
      recoverPending: async () => undefined,
      commit: async () => {
        calls.push('persist');
        await options?.persist?.();
        calls.push('publish');
        const publication = (await options?.publish?.()) ?? { published: true };
        if (!publication.published) {
          throw new CacheError(
            'Core snapshot publication lost authority during persistence',
            'CORE_SNAPSHOT_PUBLICATION_LOST_AUTHORITY',
          );
        }
        return { status: 'committed' };
      },
      cleanup: async () => {
        calls.push('cleanup');
        await options?.cleanup?.();
      },
      withPersistenceLock: async (operation) => {
        calls.push('lock');
        expect(calls).toContain('bootstrap');
        expect(calls).toContain('fixtures');
        return operation();
      },
      onMilestone: (milestone) => options?.milestones?.push(milestone),
    };
  }

  test('performs exactly two upstream reads before locking and publishes after persistence', async () => {
    const calls: string[] = [];
    const milestones: CoreSnapshotMilestone[] = [];
    const result = await syncCoreSnapshot(dependencies({ calls, milestones }));

    expect(calls.filter((call) => call === 'bootstrap')).toHaveLength(1);
    expect(calls.filter((call) => call === 'fixtures')).toHaveLength(1);
    expect(calls.indexOf('ordering-timestamp')).toBeLessThan(calls.indexOf('bootstrap'));
    expect(calls.indexOf('lock')).toBeGreaterThan(calls.indexOf('fixtures'));
    expect(calls.indexOf('persist')).toBeLessThan(calls.indexOf('publish'));
    expect(calls.indexOf('publish')).toBeLessThan(calls.indexOf('cleanup'));
    expect(milestones).toEqual(['fetched', 'validated', 'locked', 'persisted', 'published']);
    expect(result).toMatchObject({
      outcome: 'ready',
      events: 38,
      teams: 20,
      fixtures: 380,
      failedUnits: 0,
    });
  });

  test('never publishes after persistence fails', async () => {
    const calls: string[] = [];
    await expect(
      syncCoreSnapshot(
        dependencies({
          calls,
          persist: async () => {
            throw new Error('database unavailable');
          },
        }),
      ),
    ).rejects.toThrow('database unavailable');
    expect(calls).not.toContain('publish');
  });

  test('does not persist a snapshot older than the active season', async () => {
    const calls: string[] = [];
    const result = await syncCoreSnapshot(dependencies({ calls, activeSeason: '2728' }));
    expect(result.outcome).toBe('noop');
    expect(calls).not.toContain('persist');
    expect(calls).not.toContain('publish');
    expect(calls).not.toContain('cleanup');
  });

  test('skips stale-season cleanup when authority changes after commit', async () => {
    const calls: string[] = [];
    const result = await syncCoreSnapshot(
      dependencies({ calls, activeSeasons: ['2627', '2728'] }),
    );

    expect(result.outcome).toBe('ready');
    expect(calls).not.toContain('cleanup');
  });

  test('fails the attempt when publication loses authority after persistence', async () => {
    const calls: string[] = [];
    await expect(
      syncCoreSnapshot(
        dependencies({
          calls,
          publish: async () => ({ published: false }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CORE_SNAPSHOT_PUBLICATION_LOST_AUTHORITY' });
    expect(calls.indexOf('persist')).toBeLessThan(calls.indexOf('publish'));
  });
});
