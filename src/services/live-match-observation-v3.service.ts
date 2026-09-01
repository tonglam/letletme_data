import { fplClient } from '../clients/fpl';
import type { FplSeasonRef } from '../domain/fpl-season';
import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import { readLiveMatchDeskV3 } from '../cache/live-match-publication-v3';
import { loadLiveReferenceData, type LiveSnapshotReferenceData } from './live-coherent-fetch';
import {
  syncLiveMatchesV3FromObservation,
  type LiveMatchObservationResult,
} from './live-match-v3.service';
import type { MatchLifecycleState } from './live-match-v3';

export interface LiveMatchObservationV3Options {
  readonly lifecycleState?: MatchLifecycleState;
  readonly expectedNextCheckAt?: Date | string | null;
  readonly dependencies?: LiveMatchObservationV3Dependencies;
}

export interface LiveMatchObservationV3Dependencies {
  readonly getFixtures: (eventId: number) => ReturnType<typeof fplClient.getFixtures>;
  readonly getCore: (season: string) => ReturnType<typeof readCoreSnapshotCache>;
  readonly getCurrentDesk: (
    season: string,
    eventId: number,
  ) => ReturnType<typeof readLiveMatchDeskV3>;
  readonly getReferenceData: (
    season: FplSeasonRef,
    eventId: number,
  ) => Promise<LiveSnapshotReferenceData>;
  readonly syncMatches: typeof syncLiveMatchesV3FromObservation;
}

const defaultDependencies: LiveMatchObservationV3Dependencies = {
  getFixtures: (eventId) => fplClient.getFixtures(eventId),
  getCore: (season) => readCoreSnapshotCache(season),
  getCurrentDesk: (season, eventId) => readLiveMatchDeskV3({ season, eventId }),
  getReferenceData: loadLiveReferenceData,
  syncMatches: syncLiveMatchesV3FromObservation,
};

/**
 * Observe and publish only the Match V3 desk. This lane deliberately does not
 * call event-live, prepare a Live Points publication, checkpoint Live Points,
 * or fan out any downstream job. It is used before the Live Points lifecycle
 * becomes eligible, while retaining the same fixture identity and team-name
 * validation as the shared observation path.
 */
export async function syncLiveMatchObservationV3(
  season: FplSeasonRef,
  eventId: number,
  options: LiveMatchObservationV3Options = {},
): Promise<LiveMatchObservationResult> {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    throw new Error(`Invalid live event ID: ${eventId}`);
  }
  const dependencies = options.dependencies ?? defaultDependencies;
  const [rawFixtures, core, currentDesk, referenceData] = await Promise.all([
    dependencies.getFixtures(eventId),
    dependencies.getCore(season.seasonCode),
    dependencies.getCurrentDesk(season.seasonCode, eventId),
    dependencies.getReferenceData(season, eventId),
  ]);
  const expectedFixtureIds = core
    ? core.fixtures.filter((fixture) => fixture.event === eventId).map((fixture) => fixture.id)
    : currentDesk?.fixtures.map((fixture) => fixture.fixtureId);
  if (expectedFixtureIds === undefined) {
    throw new Error(`Live Match fixture identity authority is unavailable for event ${eventId}`);
  }

  return dependencies.syncMatches({
    season,
    eventId,
    rawFixtures,
    referenceData,
    expectedFixtureIds,
    lifecycleState: options.lifecycleState,
    expectedNextCheckAt: options.expectedNextCheckAt,
  });
}
