export interface FixtureEventIdentity {
  id: number;
  event: number | null;
}

export interface FixtureCacheTransitions {
  invalidatedEventIds: Set<number>;
  unscheduledFixtureIdsToRemove: Set<number>;
}

/**
 * Full fixture feeds reconcile every represented event that still owns a
 * coherent snapshot. Current/requested events also keep their unowned
 * compatibility source hashes fresh. Invalid or unrelated IDs are ignored.
 */
export function resolveFixtureDerivativeReconciliationEventIds(
  representedEventIds: readonly number[],
  ownedEventIds: readonly number[],
  compatibilityEventIds: readonly (number | null | undefined)[],
): number[] {
  const represented = new Set(
    representedEventIds.filter((eventId) => Number.isInteger(eventId) && eventId > 0),
  );
  return [
    ...new Set(
      [...ownedEventIds, ...compatibilityEventIds].filter(
        (eventId): eventId is number =>
          eventId !== null &&
          eventId !== undefined &&
          Number.isInteger(eventId) &&
          eventId > 0 &&
          represented.has(eventId),
      ),
    ),
  ].sort((left, right) => left - right);
}

/**
 * Every accepted destination participates in a fixture cache rebuild, even
 * when ownership itself did not change. Lock those destinations together with
 * transition invalidations so broad fixture refreshes cannot overlap a live
 * snapshot staging/swap for any hash they inspect or replace.
 */
export function resolveFixtureCacheLockEventIds(
  fixtures: readonly FixtureEventIdentity[],
  invalidatedEventIds: ReadonlySet<number>,
): number[] {
  const eventIds = new Set(invalidatedEventIds);
  for (const fixture of fixtures) {
    if (fixture.event !== null) eventIds.add(fixture.event);
  }
  return [...eventIds].sort((left, right) => left - right);
}

/**
 * Event-filtered FPL responses omit fixtures that have moved to another event
 * (or become unscheduled). Compare against the complete persisted ownership so
 * the caller can promote the operation to one unfiltered recovery sync.
 */
export function findOmittedEventFixtureIds(
  eventId: number,
  persistedFixtures: readonly FixtureEventIdentity[],
  acceptedFixtureIds: ReadonlySet<number>,
): number[] {
  return persistedFixtures
    .filter((fixture) => fixture.event === eventId && !acceptedFixtureIds.has(fixture.id))
    .map((fixture) => fixture.id)
    .sort((left, right) => left - right);
}

/**
 * Compare the just-accepted FPL fixture identities with their persisted event
 * ownership before upsert. Any prior event loses its entire coordinated live
 * snapshot when a fixture moves away. Any assigned destination also loses its
 * snapshot because its accepted fixture identity set is changing; otherwise a
 * snapshot-owned destination hash would reject the compatibility fixture write
 * and retain an incomplete view. A fixture leaving the unscheduled bucket also
 * invalidates that separate cache.
 */
export function resolveFixtureCacheTransitions(
  fixtures: readonly FixtureEventIdentity[],
  previousEventByFixtureId: ReadonlyMap<number, number | null>,
): FixtureCacheTransitions {
  const invalidatedEventIds = new Set<number>();
  const unscheduledFixtureIdsToRemove = new Set<number>();

  for (const fixture of fixtures) {
    const hadPreviousOwnership = previousEventByFixtureId.has(fixture.id);
    const previousEventId = previousEventByFixtureId.get(fixture.id);
    if (hadPreviousOwnership && previousEventId === fixture.event) continue;
    if (hadPreviousOwnership && previousEventId === null) {
      if (fixture.event !== null) unscheduledFixtureIdsToRemove.add(fixture.id);
    } else if (previousEventId !== undefined && previousEventId !== null) {
      invalidatedEventIds.add(previousEventId);
    }
    if (fixture.event !== null) invalidatedEventIds.add(fixture.event);
  }

  return { invalidatedEventIds, unscheduledFixtureIdsToRemove };
}
