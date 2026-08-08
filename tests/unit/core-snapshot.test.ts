import { describe, expect, test } from 'bun:test';

import {
  CORE_SNAPSHOT_MIN_PLAYERS_PER_TEAM,
  prepareCoreSnapshot,
} from '../../src/domain/core-snapshot';
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

  test('retains valid unassigned fixtures in the canonical snapshot', () => {
    const input = buildCoreSnapshotFixture();
    input.fixtures[0] = { ...input.fixtures[0], event: null };

    const snapshot = prepareCoreSnapshot(input.bootstrap, input.fixtures);

    expect(snapshot.fixtures[0].event).toBeNull();
    expect(snapshot.fixtures).toHaveLength(380);
  });
});
