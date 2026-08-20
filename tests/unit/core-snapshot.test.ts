import { describe, expect, test } from 'bun:test';

import {
  CORE_SNAPSHOT_MIN_PLAYERS_PER_TEAM,
  normalizeSelectionRules,
  prepareCoreSnapshot,
} from '../../src/domain/core-snapshot';
import { buildCoreSnapshotFixture } from '../fixtures/core-snapshot.fixtures';

describe('core snapshot validation', () => {
  test('normalizes official squad and chip rules without hardcoded downstream defaults', () => {
    const input = buildCoreSnapshotFixture();
    input.bootstrap.game_settings = {
      squad_squadsize: 15,
      squad_squadplay: 11,
      squad_total_spend: 1000,
      squad_team_limit: 3,
      ui_currency_multiplier: 10,
    };
    input.bootstrap.element_types = [1, 2, 3, 4].map((id) => ({
      id,
      singular_name: ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'][id - 1],
      singular_name_short: ['GKP', 'DEF', 'MID', 'FWD'][id - 1],
      squad_select: [2, 5, 5, 3][id - 1],
      squad_min_play: [1, 3, 2, 1][id - 1],
      squad_max_play: [1, 5, 5, 3][id - 1],
    }));
    input.bootstrap.chips = [
      {
        id: 1,
        name: 'wildcard',
        number: 1,
        start_event: 2,
        stop_event: 19,
        chip_type: 'transfer',
      },
    ];

    expect(normalizeSelectionRules(input.bootstrap)).toMatchObject({
      squadSize: 15,
      startingSize: 11,
      budget: 1000,
      maxPlayersPerTeam: 3,
      positions: [
        { id: 1, minPlay: 1, maxPlay: 1 },
        { id: 2, minPlay: 3, maxPlay: 5 },
        { id: 3, minPlay: 2, maxPlay: 5 },
        { id: 4, minPlay: 1, maxPlay: 3 },
      ],
      chips: [{ name: 'wildcard', startEvent: 2, stopEvent: 19 }],
    });
  });

  test('accepts distinct chips that share an official chip type', () => {
    const input = buildCoreSnapshotFixture();
    input.bootstrap.game_settings = {
      squad_squadsize: 15,
      squad_squadplay: 11,
      squad_total_spend: 1000,
      squad_team_limit: 3,
      ui_currency_multiplier: 10,
    };
    input.bootstrap.element_types = [1, 2, 3, 4].map((id) => ({
      id,
      singular_name: ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'][id - 1],
      singular_name_short: ['GKP', 'DEF', 'MID', 'FWD'][id - 1],
      squad_select: [2, 5, 5, 3][id - 1],
      squad_min_play: [1, 3, 2, 1][id - 1],
      squad_max_play: [1, 5, 5, 3][id - 1],
    }));
    input.bootstrap.chips = [
      {
        id: 1,
        name: 'wildcard',
        number: 1,
        start_event: 2,
        stop_event: 19,
        chip_type: 'transfer',
      },
      {
        id: 2,
        name: 'free_hit',
        number: 1,
        start_event: 20,
        stop_event: 38,
        chip_type: 'transfer',
      },
    ];

    const rules = normalizeSelectionRules(input.bootstrap);
    expect(rules?.chips.map((chip) => chip.id)).toEqual([1, 2]);
  });

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

  test('rejects a partially published official rules payload', () => {
    const input = buildCoreSnapshotFixture();
    input.bootstrap.game_settings = { squad_squadsize: 15 };
    expect(() => prepareCoreSnapshot(input.bootstrap, input.fixtures)).toThrow(
      'official selection rules are incomplete',
    );
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
