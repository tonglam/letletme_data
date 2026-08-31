import type { RawFPLEventLiveElement, RawFPLFixture } from '../types';
import { prepareEventLives } from './event-lives.service';
import { validateLiveElementIdentity, type LiveSnapshotReferenceData } from './live-coherent-fetch';
import { transformFixtures } from '../transformers/fixtures';

export type MatchLifecycleState =
  | 'PRE_DEADLINE'
  | 'LIVE_ACTIVE'
  | 'BETWEEN_FIXTURES'
  | 'DAY_SETTLING'
  | 'GW_REVIEW'
  | 'FINALIZED';

/** Map the broader live scheduler state to the Match publication lifecycle. */
export function normalizeMatchLifecycleState(value: unknown): MatchLifecycleState | undefined {
  if (
    value === 'PRE_DEADLINE' ||
    value === 'PICKS_WAIT' ||
    value === 'PICKS_PROBE' ||
    value === 'PICKS_SYNC'
  ) {
    return 'PRE_DEADLINE';
  }
  if (
    value === 'LIVE_ACTIVE' ||
    value === 'BETWEEN_FIXTURES' ||
    value === 'DAY_SETTLING' ||
    value === 'GW_REVIEW' ||
    value === 'FINALIZED'
  ) {
    return value;
  }
  return undefined;
}

export interface MatchDeskFixture {
  readonly fixtureId: number;
  readonly eventId: number;
  readonly homeTeamId: number;
  readonly homeTeamName: string;
  readonly homeTeamShortName: string;
  readonly awayTeamId: number;
  readonly awayTeamName: string;
  readonly awayTeamShortName: string;
  readonly homeScore: number | null;
  readonly awayScore: number | null;
  readonly kickoffTime: string | null;
  readonly minutes: number;
  readonly started: boolean;
  readonly finished: boolean;
  readonly finishedProvisional: boolean;
}

export interface MatchDetailStat {
  readonly identifier: string;
  readonly value: number;
  readonly points: number;
  readonly pointsModification: number | null;
}

export interface MatchDetailPlayer {
  readonly id: number;
  readonly webName: string;
  readonly position: number;
  readonly teamId: number;
  readonly totalPoints: number;
  readonly stats: readonly MatchDetailStat[];
}

export interface MatchFixtureDetail {
  readonly fixtureId: number;
  readonly players: readonly MatchDetailPlayer[];
}

export interface PreparedLiveMatchDesk {
  readonly eventId: number;
  readonly state: MatchLifecycleState;
  readonly fixtures: readonly MatchDeskFixture[];
}

export interface PreparedLiveMatchDetail {
  readonly eventId: number;
  readonly fixtures: readonly MatchFixtureDetail[];
}

type PreviousDeskIdentity = Pick<
  MatchDeskFixture,
  | 'homeTeamId'
  | 'homeTeamName'
  | 'homeTeamShortName'
  | 'awayTeamId'
  | 'awayTeamName'
  | 'awayTeamShortName'
>;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertTeamIdentity(
  teamId: number,
  label: string,
  referenceData: LiveSnapshotReferenceData | null,
  previousByTeamId: ReadonlyMap<number, { name: string; shortName: string }>,
): { name: string; shortName: string } {
  assertPositiveInteger(teamId, label);
  const name = referenceData?.nameById.get(teamId) ?? previousByTeamId.get(teamId)?.name ?? '';
  const shortName =
    referenceData?.shortNameById.get(teamId) ?? previousByTeamId.get(teamId)?.shortName ?? '';
  if (!name.trim() || !shortName.trim()) {
    throw new Error(`Live Match desk is missing team identity for ${label}=${teamId}`);
  }
  return { name, shortName };
}

function previousTeamIdentity(
  previous: readonly MatchDeskFixture[] | undefined,
): ReadonlyMap<number, { name: string; shortName: string }> {
  const result = new Map<number, { name: string; shortName: string }>();
  for (const fixture of previous ?? []) {
    result.set(fixture.homeTeamId, {
      name: fixture.homeTeamName,
      shortName: fixture.homeTeamShortName,
    });
    result.set(fixture.awayTeamId, {
      name: fixture.awayTeamName,
      shortName: fixture.awayTeamShortName,
    });
  }
  return result;
}

function fixtureIdsFromBaseline(expectedFixtureIds: readonly number[] | undefined): Set<number> {
  if (expectedFixtureIds === undefined) return new Set();
  const ids = new Set<number>();
  for (const fixtureId of expectedFixtureIds) {
    assertPositiveInteger(fixtureId, 'Expected fixture ID');
    if (ids.has(fixtureId)) throw new Error(`Duplicate expected fixture ID ${fixtureId}`);
    ids.add(fixtureId);
  }
  return ids;
}

function assertFixtureSet(
  eventId: number,
  actualFixtureIds: readonly number[],
  expectedFixtureIds: readonly number[] | undefined,
): void {
  const actual = new Set(actualFixtureIds);
  if (actual.size !== actualFixtureIds.length) {
    throw new Error(`Duplicate fixture identity in live match event ${eventId}`);
  }
  if (expectedFixtureIds === undefined) return;
  const expected = fixtureIdsFromBaseline(expectedFixtureIds);
  const missing = [...expected].filter((fixtureId) => !actual.has(fixtureId));
  const unexpected = actualFixtureIds.filter((fixtureId) => !expected.has(fixtureId));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Live Match fixture identity mismatch for event ${eventId}; missing=${missing.sort((a, b) => a - b).join(',') || 'none'}; unexpected=${unexpected.sort((a, b) => a - b).join(',') || 'none'}`,
    );
  }
}

export function resolveLiveMatchLifecycleState(
  fixtures: readonly Pick<MatchDeskFixture, 'started' | 'finished' | 'finishedProvisional'>[],
  finalized = false,
): MatchLifecycleState {
  if (finalized) return 'FINALIZED';
  if (fixtures.length === 0) return 'PRE_DEADLINE';
  if (
    fixtures.some((fixture) => fixture.started && !fixture.finished && !fixture.finishedProvisional)
  ) {
    return 'LIVE_ACTIVE';
  }
  if (fixtures.every((fixture) => fixture.finished || fixture.finishedProvisional)) {
    return 'DAY_SETTLING';
  }
  if (
    fixtures.some((fixture) => fixture.started || fixture.finished || fixture.finishedProvisional)
  ) {
    return 'BETWEEN_FIXTURES';
  }
  return 'PRE_DEADLINE';
}

function resolveObservedMatchLifecycleState(
  fixtures: readonly Pick<MatchDeskFixture, 'started' | 'finished' | 'finishedProvisional'>[],
  requested: MatchLifecycleState | undefined,
  finalized: boolean,
): MatchLifecycleState {
  if (finalized) return 'FINALIZED';
  const observed = resolveLiveMatchLifecycleState(fixtures, false);

  // Queue payloads retain the scheduler state captured when they were
  // enqueued. A retry must not overwrite current fixture evidence with an old
  // PRE_DEADLINE/LIVE_ACTIVE/BETWEEN_FIXTURES value. GW_REVIEW is the only
  // non-final milestone that fixtures cannot derive themselves, so preserve it
  // only after the observed matchday has settled (including a blank event).
  if (
    (requested === 'GW_REVIEW' || requested === 'FINALIZED') &&
    (observed === 'DAY_SETTLING' || (observed === 'PRE_DEADLINE' && fixtures.length === 0))
  ) {
    return 'GW_REVIEW';
  }
  return observed;
}

/**
 * Convert only fixture identity and score state into the compact Match desk.
 * This function deliberately ignores raw fixture stats: a BPS-only change is
 * detail content and must not advance the desk publication.
 */
export function prepareLiveMatchDesk(input: {
  readonly eventId: number;
  readonly rawFixtures: readonly RawFPLFixture[];
  readonly referenceData: LiveSnapshotReferenceData | null;
  readonly expectedFixtureIds?: readonly number[];
  readonly previousFixtures?: readonly MatchDeskFixture[];
  readonly finalized?: boolean;
  readonly lifecycleState?: MatchLifecycleState;
}): PreparedLiveMatchDesk {
  const { eventId, rawFixtures, referenceData, expectedFixtureIds, previousFixtures } = input;
  assertPositiveInteger(eventId, 'Live Match event ID');
  if (!Array.isArray(rawFixtures)) throw new Error('FPL fixtures response is not an array');

  const ids = rawFixtures.map((fixture) => fixture.id);
  assertFixtureSet(eventId, ids, expectedFixtureIds);
  const previousByTeamId = previousTeamIdentity(previousFixtures);
  const transformed = transformFixtures([...rawFixtures]);
  if (transformed.length !== rawFixtures.length) {
    throw new Error(`Live Match desk dropped fixtures for event ${eventId}`);
  }

  const fixtures = transformed
    .map((fixture): MatchDeskFixture => {
      if (fixture.event !== null && fixture.event !== eventId) {
        throw new Error(
          `FPL fixture ${fixture.id} belongs to event ${fixture.event}, not ${eventId}`,
        );
      }
      const home = assertTeamIdentity(fixture.teamH, 'homeTeamId', referenceData, previousByTeamId);
      const away = assertTeamIdentity(fixture.teamA, 'awayTeamId', referenceData, previousByTeamId);
      if (fixture.teamH === fixture.teamA) {
        throw new Error(`Live Match fixture ${fixture.id} has identical teams`);
      }
      assertNonNegativeInteger(fixture.minutes, `fixture ${fixture.id} minutes`);
      return {
        fixtureId: fixture.id,
        eventId,
        homeTeamId: fixture.teamH,
        homeTeamName: home.name,
        homeTeamShortName: home.shortName,
        awayTeamId: fixture.teamA,
        awayTeamName: away.name,
        awayTeamShortName: away.shortName,
        homeScore: fixture.teamHScore,
        awayScore: fixture.teamAScore,
        kickoffTime: fixture.kickoffTime?.toISOString() ?? null,
        minutes: fixture.minutes,
        started: fixture.started === true,
        finished: fixture.finished,
        finishedProvisional: fixture.finishedProvisional,
      };
    })
    .sort((left, right) => left.fixtureId - right.fixtureId);

  return {
    eventId,
    fixtures,
    state: resolveObservedMatchLifecycleState(
      fixtures,
      input.lifecycleState,
      input.finalized === true,
    ),
  };
}

function bpsByFixtureAndPlayer(rawFixtures: readonly RawFPLFixture[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const fixture of rawFixtures) {
    const bps = fixture.stats.find((stat) => stat.identifier === 'bps');
    if (!bps) continue;
    for (const row of [...bps.h, ...bps.a]) {
      assertPositiveInteger(row.element, 'BPS player ID');
      const key = `${fixture.id}:${row.element}`;
      if (result.has(key)) throw new Error(`Duplicate fixture BPS row ${key}`);
      if (!Number.isFinite(row.value)) throw new Error(`Invalid fixture BPS value ${key}`);
      result.set(key, row.value);
    }
  }
  return result;
}

function statSort(left: MatchDetailStat, right: MatchDetailStat): number {
  return left.identifier < right.identifier ? -1 : left.identifier > right.identifier ? 1 : 0;
}

function statsHaveVisibleValue(stats: readonly MatchDetailStat[]): boolean {
  return stats.some(
    (stat) => stat.value !== 0 || stat.points !== 0 || (stat.pointsModification ?? 0) !== 0,
  );
}

function buildDetailPlayer(input: {
  readonly elementId: number;
  readonly fixtureId: number;
  readonly stats: readonly MatchDetailStat[];
  readonly referenceData: LiveSnapshotReferenceData;
  readonly fixtureTeamIds: ReadonlySet<number>;
}): MatchDetailPlayer | null {
  const player =
    input.referenceData.playerByFixtureAndId?.get(`${input.fixtureId}:${input.elementId}`) ??
    input.referenceData.playerById?.get(input.elementId);
  if (!player) {
    throw new Error(`Live Match detail is missing player identity for element ${input.elementId}`);
  }
  if (!Number.isInteger(player.type) || player.type < 1 || player.type > 4) {
    throw new Error(`Live Match detail has invalid position for element ${input.elementId}`);
  }
  if (!player.webName.trim()) {
    throw new Error(`Live Match detail has empty player name for element ${input.elementId}`);
  }
  if (player.teamId <= 0) {
    throw new Error(`Live Match detail has invalid player team for element ${input.elementId}`);
  }
  if (!input.fixtureTeamIds.has(player.teamId)) {
    throw new Error(
      `Live Match detail has no event-time team identity for fixture ${input.fixtureId} element ${input.elementId}`,
    );
  }
  const stats = [...input.stats].sort(statSort);
  if (!statsHaveVisibleValue(stats)) return null;
  const totalPoints = stats.reduce(
    (sum, stat) => sum + stat.points + (stat.pointsModification ?? 0),
    0,
  );
  if (!Number.isSafeInteger(totalPoints)) {
    throw new Error(
      `Live Match detail points are not an integer for fixture ${input.fixtureId} element ${input.elementId}`,
    );
  }
  return {
    id: player.id,
    webName: player.webName,
    position: player.type,
    teamId: player.teamId,
    totalPoints,
    stats,
  };
}

/**
 * Build detail at fixture grain.  Event-level totals are never used to fill a
 * fixture: all points and explain rows originate from that fixture's explain
 * block, while BPS comes from that fixture's own `stats` entry. This is the
 * invariant that prevents DGW duplication.
 */
export function prepareLiveMatchDetail(input: {
  readonly eventId: number;
  readonly rawElements: readonly RawFPLEventLiveElement[];
  readonly rawFixtures: readonly RawFPLFixture[];
  readonly deskFixtures: readonly MatchDeskFixture[];
  readonly referenceData: LiveSnapshotReferenceData;
  readonly publishedLiveElementIds?: readonly number[];
}): PreparedLiveMatchDetail {
  const {
    eventId,
    rawElements,
    rawFixtures,
    deskFixtures,
    referenceData,
    publishedLiveElementIds,
  } = input;
  assertPositiveInteger(eventId, 'Live Match event ID');
  if (!referenceData.playerById && !referenceData.playerByFixtureAndId) {
    throw new Error('Live Match detail requires an event player identity baseline');
  }
  validateLiveElementIdentity(
    eventId,
    rawElements.map((element) => element.id),
    referenceData,
    publishedLiveElementIds,
  );
  const fixtureIds = new Set(deskFixtures.map((fixture) => fixture.fixtureId));
  if (fixtureIds.size !== deskFixtures.length) {
    throw new Error(`Live Match desk contains duplicate fixtures for event ${eventId}`);
  }
  const prepared = prepareEventLives(eventId, [...rawElements]);
  if (
    prepared.errors !== 0 ||
    prepared.sourceCount !== rawElements.length ||
    prepared.eventLives.length !== rawElements.length
  ) {
    throw new Error(`Live Match detail transformation is incomplete for event ${eventId}`);
  }
  const bps = bpsByFixtureAndPlayer(rawFixtures);
  const fixtureTeamIds = new Map(
    deskFixtures.map((fixture) => [
      fixture.fixtureId,
      new Set([fixture.homeTeamId, fixture.awayTeamId]),
    ]),
  );
  const playersByFixture = new Map<number, Map<number, MatchDetailPlayer>>();
  for (const fixtureId of fixtureIds) playersByFixture.set(fixtureId, new Map());

  for (const row of prepared.eventLives) {
    const breakdown = row.fixtureBreakdown ?? [];
    for (const fixture of breakdown) {
      if (!fixtureIds.has(fixture.fixtureId)) {
        throw new Error(
          `Live Match detail contains fixture ${fixture.fixtureId} outside event ${eventId}`,
        );
      }
      const stats = fixture.stats.map((stat) => ({
        identifier: stat.identifier,
        value: stat.value,
        points: stat.points,
        pointsModification: stat.pointsModification,
      }));
      const bpsValue = bps.get(`${fixture.fixtureId}:${row.elementId}`);
      if (bpsValue !== undefined && !stats.some((stat) => stat.identifier === 'bps')) {
        stats.push({ identifier: 'bps', value: bpsValue, points: 0, pointsModification: null });
      }
      const player = buildDetailPlayer({
        elementId: row.elementId,
        fixtureId: fixture.fixtureId,
        stats,
        referenceData,
        fixtureTeamIds: fixtureTeamIds.get(fixture.fixtureId) ?? new Set(),
      });
      if (player) playersByFixture.get(fixture.fixtureId)?.set(player.id, player);
    }
  }

  // A provider can expose fixture BPS before it emits an explain block. Keep
  // that fixture-specific signal visible, but never infer points from it.
  for (const [key, bpsValue] of bps.entries()) {
    const separator = key.indexOf(':');
    const fixtureId = Number(key.slice(0, separator));
    const elementId = Number(key.slice(separator + 1));
    const bucket = playersByFixture.get(fixtureId);
    if (!bucket || [...bucket.values()].some((player) => player.id === elementId)) continue;
    const player = buildDetailPlayer({
      elementId,
      fixtureId,
      stats: [{ identifier: 'bps', value: bpsValue, points: 0, pointsModification: null }],
      referenceData,
      fixtureTeamIds: fixtureTeamIds.get(fixtureId) ?? new Set(),
    });
    if (player) bucket.set(player.id, player);
  }

  return {
    eventId,
    fixtures: [...deskFixtures]
      .sort((left, right) => left.fixtureId - right.fixtureId)
      .map((fixture) => ({
        fixtureId: fixture.fixtureId,
        players: [...(playersByFixture.get(fixture.fixtureId)?.values() ?? [])].sort(
          (left, right) => left.id - right.id,
        ),
      })),
  };
}

export function hasStartedLiveMatchDetail(
  fixtures: readonly MatchDeskFixture[],
  detail: PreparedLiveMatchDetail,
): boolean {
  const startedFixtureIds = new Set(
    fixtures
      .filter(
        (fixture) =>
          fixture.started || fixture.finished || fixture.finishedProvisional || fixture.minutes > 0,
      )
      .map((fixture) => fixture.fixtureId),
  );
  return detail.fixtures.some((fixture) => startedFixtureIds.has(fixture.fixtureId));
}

export type { PreviousDeskIdentity };
