import { deriveFplSeasonFromEvents, deriveFplSeasonFromFixtures } from './fpl-source-season';
import { transformEvents } from '../transformers/events';
import { transformFixtures } from '../transformers/fixtures';
import { transformPhases } from '../transformers/phases';
import { transformPlayersStrict } from '../transformers/players';
import { transformTeams } from '../transformers/teams';
import { ValidationError } from '../utils/errors';

import type {
  Event,
  Fixture,
  FPLBootstrapResponse,
  Phase,
  Player,
  RawFPLFixture,
  Team,
} from '../types';

export interface SelectionRulePosition {
  id: number;
  name: string;
  shortName: string;
  squadSelect: number;
  minPlay: number;
  maxPlay: number;
}

export interface SelectionRuleChipWindow {
  id: number;
  name: string;
  number: number;
  startEvent: number;
  stopEvent: number;
  chipType: string;
}

export interface SelectionRules {
  squadSize: number;
  startingSize: number;
  budget: number;
  maxPlayersPerTeam: number;
  currencyMultiplier: number;
  positions: SelectionRulePosition[];
  chips: SelectionRuleChipWindow[];
}

export const CORE_SNAPSHOT_EXPECTED_EVENTS = 38;
export const CORE_SNAPSHOT_EXPECTED_TEAMS = 20;
export const CORE_SNAPSHOT_EXPECTED_FIXTURES = 380;
// A valid FPL club must have enough selectable players to field a starting XI.
// This deliberately conservative floor catches severely truncated bootstrap
// payloads without coupling publication to the season's fluctuating squad size.
export const CORE_SNAPSHOT_MIN_PLAYERS_PER_TEAM = 11;

export const CORE_SNAPSHOT_MUTATION_SCOPES = [
  'data-core:events',
  'data-core:teams',
  'data-core:players',
  'data-core:phases',
  'data-core:fixtures',
] as const;

export interface CoreSnapshot {
  season: string;
  events: Event[];
  teams: Team[];
  players: Player[];
  phases: Phase[];
  fixtures: Fixture[];
  selectionRules?: SelectionRules | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
};

/** Normalize official bootstrap rules into the cross-service public contract. */
export function normalizeSelectionRules(bootstrap: FPLBootstrapResponse): SelectionRules | null {
  const settings = asRecord(bootstrap.game_settings);
  const squadSize = asFiniteNumber(settings?.squad_squadsize);
  const startingSize = asFiniteNumber(settings?.squad_squadplay);
  const budget = asFiniteNumber(settings?.squad_total_spend);
  const maxPlayersPerTeam = asFiniteNumber(settings?.squad_team_limit);
  const currencyMultiplier = asFiniteNumber(settings?.ui_currency_multiplier);
  const rawPositions = bootstrap.element_types
    .map(asRecord)
    .filter((value): value is Record<string, unknown> => value !== null);
  const positions = rawPositions.flatMap((position) => {
    const id = asFiniteNumber(position.id);
    const squadSelect = asFiniteNumber(position.squad_select);
    const minPlay = asFiniteNumber(position.squad_min_play);
    const maxPlay = asFiniteNumber(position.squad_max_play);
    if (
      id === null ||
      squadSelect === null ||
      minPlay === null ||
      maxPlay === null ||
      id <= 0 ||
      minPlay > maxPlay
    ) {
      return [];
    }
    const name =
      typeof position.singular_name === 'string' ? position.singular_name : `Position ${id}`;
    const shortName =
      typeof position.singular_name_short === 'string' ? position.singular_name_short : name;
    return [{ id, name, shortName, squadSelect, minPlay, maxPlay }];
  });
  const chips = bootstrap.chips.flatMap((chip) => {
    const id = asFiniteNumber(chip.id);
    const number = asFiniteNumber(chip.number);
    if (
      id === null ||
      number === null ||
      chip.start_event < 1 ||
      chip.stop_event < chip.start_event
    ) {
      return [];
    }
    return [
      {
        id,
        name: chip.name,
        number,
        startEvent: chip.start_event,
        stopEvent: chip.stop_event,
        chipType: chip.chip_type,
      },
    ];
  });
  if (
    squadSize === null ||
    startingSize === null ||
    budget === null ||
    maxPlayersPerTeam === null ||
    currencyMultiplier === null ||
    positions.length !== rawPositions.length ||
    positions.length === 0 ||
    new Set(positions.map((position) => position.id)).size !== positions.length ||
    chips.length !== bootstrap.chips.length
  ) {
    return null;
  }
  return {
    squadSize,
    startingSize,
    budget,
    maxPlayersPerTeam,
    currencyMultiplier,
    positions,
    chips,
  };
}

function reject(reason: string, details?: Record<string, number>): never {
  throw new ValidationError(
    `Core snapshot rejected: ${reason}`,
    'CORE_SNAPSHOT_INCOMPLETE',
    details,
  );
}

function requireExactCount(label: string, actual: number, expected: number): void {
  if (actual !== expected) reject(`${label} count`, { actual, expected });
}

function requireUniqueIds(label: string, ids: number[]): void {
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    reject(`${label} identifiers are not unique`, {
      actual: ids.length,
      unique: unique.size,
    });
  }
}

function requireCompleteEventRange(events: Event[]): void {
  const ids = new Set(events.map((event) => event.id));
  for (let eventId = 1; eventId <= CORE_SNAPSHOT_EXPECTED_EVENTS; eventId += 1) {
    if (!ids.has(eventId)) reject('event range is incomplete');
  }
}

function requirePlayerCoverage(players: Player[], teamIds: Set<number>): void {
  if (players.length === 0) reject('players are empty');
  requireUniqueIds(
    'player',
    players.map((player) => player.id),
  );

  const positions = new Set<number>();
  const playersByTeam = new Map<number, number>([...teamIds].map((teamId) => [teamId, 0]));
  for (const player of players) {
    if (!teamIds.has(player.teamId)) reject('player references an unknown team');
    if (player.type < 1 || player.type > 4) reject('player position is outside 1-4');
    positions.add(player.type);
    playersByTeam.set(player.teamId, (playersByTeam.get(player.teamId) ?? 0) + 1);
  }

  if (positions.size !== 4) reject('player positions are incomplete', { actual: positions.size });
  for (const [teamId, count] of playersByTeam) {
    if (count < CORE_SNAPSHOT_MIN_PLAYERS_PER_TEAM) {
      reject('player team roster is incomplete', {
        teamId,
        actual: count,
        expected: CORE_SNAPSHOT_MIN_PLAYERS_PER_TEAM,
      });
    }
  }
}

function requirePhaseCoverage(phases: Phase[]): void {
  if (phases.length === 0) reject('phases are empty');
  requireUniqueIds(
    'phase',
    phases.map((phase) => phase.id),
  );

  for (const phase of phases) {
    if (
      phase.startEvent < 1 ||
      phase.stopEvent > CORE_SNAPSHOT_EXPECTED_EVENTS ||
      phase.startEvent > phase.stopEvent
    ) {
      reject('phase range is invalid');
    }
  }

  if (
    !phases.some(
      (phase) => phase.startEvent === 1 && phase.stopEvent === CORE_SNAPSHOT_EXPECTED_EVENTS,
    )
  ) {
    reject('full-season phase is missing');
  }
}

function requireFixtureCoverage(fixtures: Fixture[], teamIds: Set<number>): void {
  requireExactCount('fixtures', fixtures.length, CORE_SNAPSHOT_EXPECTED_FIXTURES);
  requireUniqueIds(
    'fixture',
    fixtures.map((fixture) => fixture.id),
  );

  const appearances = new Map<number, number>([...teamIds].map((teamId) => [teamId, 0]));
  const pairings = new Map<string, { lowerHome: number; upperHome: number }>();
  for (const fixture of fixtures) {
    if (!teamIds.has(fixture.teamH) || !teamIds.has(fixture.teamA)) {
      reject('fixture references an unknown team');
    }
    if (fixture.teamH === fixture.teamA) reject('fixture has the same home and away team');
    if (
      fixture.event !== null &&
      (fixture.event < 1 || fixture.event > CORE_SNAPSHOT_EXPECTED_EVENTS)
    ) {
      reject('fixture event is outside 1-38');
    }
    appearances.set(fixture.teamH, (appearances.get(fixture.teamH) ?? 0) + 1);
    appearances.set(fixture.teamA, (appearances.get(fixture.teamA) ?? 0) + 1);
    const lower = Math.min(fixture.teamH, fixture.teamA);
    const upper = Math.max(fixture.teamH, fixture.teamA);
    const pairing = pairings.get(`${lower}:${upper}`) ?? { lowerHome: 0, upperHome: 0 };
    if (fixture.teamH === lower) pairing.lowerHome += 1;
    else pairing.upperHome += 1;
    pairings.set(`${lower}:${upper}`, pairing);
  }

  for (const count of appearances.values()) {
    if (count !== CORE_SNAPSHOT_EXPECTED_EVENTS) {
      reject('team fixture coverage is incomplete', {
        actual: count,
        expected: CORE_SNAPSHOT_EXPECTED_EVENTS,
      });
    }
  }

  const expectedPairings = (teamIds.size * (teamIds.size - 1)) / 2;
  if (pairings.size !== expectedPairings) {
    reject('fixture opponent pair coverage is incomplete', {
      actual: pairings.size,
      expected: expectedPairings,
    });
  }
  for (const pairing of pairings.values()) {
    if (pairing.lowerHome !== 1 || pairing.upperHome !== 1) {
      reject('fixture home-and-away pairing is invalid');
    }
  }
}

export function prepareCoreSnapshot(
  bootstrap: FPLBootstrapResponse,
  rawFixtures: RawFPLFixture[],
): CoreSnapshot {
  requireExactCount('events', bootstrap.events.length, CORE_SNAPSHOT_EXPECTED_EVENTS);
  requireExactCount('teams', bootstrap.teams.length, CORE_SNAPSHOT_EXPECTED_TEAMS);
  requireExactCount('fixtures', rawFixtures.length, CORE_SNAPSHOT_EXPECTED_FIXTURES);

  const events = transformEvents(bootstrap.events);
  const teams = transformTeams(bootstrap.teams);
  const players = transformPlayersStrict(bootstrap.elements);
  const phases = transformPhases(bootstrap.phases);
  const fixtures = transformFixtures(rawFixtures);

  requireExactCount('transformed events', events.length, bootstrap.events.length);
  requireExactCount('transformed teams', teams.length, bootstrap.teams.length);
  requireExactCount('transformed players', players.length, bootstrap.elements.length);
  requireExactCount('transformed phases', phases.length, bootstrap.phases.length);
  requireExactCount('transformed fixtures', fixtures.length, rawFixtures.length);

  requireUniqueIds(
    'event',
    events.map((event) => event.id),
  );
  requireCompleteEventRange(events);
  requireUniqueIds(
    'team',
    teams.map((team) => team.id),
  );
  const teamIds = new Set(teams.map((team) => team.id));
  requirePlayerCoverage(players, teamIds);
  requirePhaseCoverage(phases);
  requireFixtureCoverage(fixtures, teamIds);

  const eventSeason = deriveFplSeasonFromEvents(bootstrap.events);
  const fixtureSeason = deriveFplSeasonFromFixtures(rawFixtures);
  if (!eventSeason || !fixtureSeason) reject('season cannot be derived from both sources');
  if (eventSeason !== fixtureSeason) reject('event and fixture seasons disagree');

  const selectionRules = normalizeSelectionRules(bootstrap);
  const hasRulePayload =
    (asRecord(bootstrap.game_settings) &&
      Object.keys(asRecord(bootstrap.game_settings) ?? {}).length > 0) ||
    bootstrap.element_types.length > 0 ||
    bootstrap.chips.length > 0;
  if (!selectionRules && hasRulePayload) reject('official selection rules are incomplete');

  return {
    season: eventSeason,
    events,
    teams,
    players,
    phases,
    fixtures,
    selectionRules,
  };
}
