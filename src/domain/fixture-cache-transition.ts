export interface FixtureEventIdentity {
  id: number;
  event: number | null;
}

export interface FixtureCacheTransitions {
  invalidatedEventIds: Set<number>;
  unscheduledFixtureIdsToRemove: Set<number>;
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
