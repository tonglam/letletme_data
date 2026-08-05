import { liveSnapshotCache } from '../cache/operations';
import { CORE_SNAPSHOT_EXPECTED_EVENTS } from '../domain/core-snapshot';
import { computeFixtureSummedBonusByTeam } from '../domain/live-bonus';
import { fixtureRepository } from '../repositories/fixtures';
import { withLiveSnapshotEventsSerialization } from './live-snapshot.service';

import type { LiveBonusByTeam } from '../domain/live-bonus';
import type { EventId, TeamId } from '../types/base.type';
import type { Fixture } from '../types';

type CoreFixtureDerivativeCoordinator = Pick<
  typeof liveSnapshotCache,
  'refreshFixtureDerivatives' | 'retire'
>;

export interface CoreFixtureDerivativeDependencies {
  findByIds: (fixtureIds: readonly number[]) => Promise<Fixture[]>;
  coordinator: CoreFixtureDerivativeCoordinator;
  serializeEvents: (eventIds: readonly number[], operation: () => Promise<void>) => Promise<void>;
}

const defaultDependencies: CoreFixtureDerivativeDependencies = {
  findByIds: fixtureRepository.findByIds,
  coordinator: liveSnapshotCache,
  serializeEvents: (eventIds, operation) =>
    withLiveSnapshotEventsSerialization(eventIds, async () => operation()),
};

function serializeBonusByTeam(source: Map<TeamId, Map<number, number>>): LiveBonusByTeam {
  return Object.fromEntries(
    [...source].map(([teamId, playerBonus]) => [
      String(teamId),
      Object.fromEntries([...playerBonus].map(([elementId, bonus]) => [String(elementId), bonus])),
    ]),
  ) as LiveBonusByTeam;
}

/**
 * Reconcile fixture-owned Live cache views against the canonical rows accepted
 * by a complete core publication. Unchanged owned snapshots remain intact;
 * changed ones are retired atomically by the coordinator and fall back to the
 * corrected fixture source until the separately managed Live pipeline republishes.
 */
export async function reconcileCoreFixtureDerivatives(
  fixtureIds: readonly number[],
  sourceCheckedAt: Date,
  dependencies: CoreFixtureDerivativeDependencies = defaultDependencies,
): Promise<{ checkedEvents: number; retiredEmptyEvents: number }> {
  let retiredEmptyEvents = 0;
  const eventIds = Array.from({ length: CORE_SNAPSHOT_EXPECTED_EVENTS }, (_, index) => index + 1);
  await dependencies.serializeEvents(eventIds, async () => {
    // Read canonical rows only after acquiring the same event fence as Live
    // writers. A Live commit that won the fence must be the source used to
    // rebuild fallback derivatives when its Redis publication is delayed.
    const fixtures = await dependencies.findByIds(fixtureIds);
    const preserveOwnedCheckedAtOrAfter = sourceCheckedAt.toISOString();
    const byEvent = new Map<EventId, Fixture[]>();
    for (const fixture of fixtures) {
      if (fixture.event === null) continue;
      const eventFixtures = byEvent.get(fixture.event) ?? [];
      eventFixtures.push(fixture);
      byEvent.set(fixture.event, eventFixtures);
    }

    for (const eventId of eventIds) {
      const eventFixtures = byEvent.get(eventId) ?? [];
      if (eventFixtures.length > 0) {
        const byTeam = serializeBonusByTeam(computeFixtureSummedBonusByTeam(eventFixtures));
        await dependencies.coordinator.refreshFixtureDerivatives(
          eventId,
          eventFixtures,
          byTeam,
          preserveOwnedCheckedAtOrAfter,
        );
        continue;
      }

      const retirement = await dependencies.coordinator.retire(
        eventId,
        preserveOwnedCheckedAtOrAfter,
      );
      if (retirement.removedKeys > 0) retiredEmptyEvents += 1;
    }
  });

  return { checkedEvents: CORE_SNAPSHOT_EXPECTED_EVENTS, retiredEmptyEvents };
}
