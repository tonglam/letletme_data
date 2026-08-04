export interface FixtureEventIdentity {
  id: number;
  event: number | null;
}

export interface FixtureCacheTransitions {
  invalidatedEventIds: Set<number>;
  shouldClearUnscheduled: boolean;
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
  let shouldClearUnscheduled = false;

  for (const fixture of fixtures) {
    const hadPreviousOwnership = previousEventByFixtureId.has(fixture.id);
    const previousEventId = previousEventByFixtureId.get(fixture.id);
    if (hadPreviousOwnership && previousEventId === fixture.event) continue;
    if (hadPreviousOwnership && previousEventId === null) {
      if (fixture.event !== null) shouldClearUnscheduled = true;
    } else if (previousEventId !== undefined && previousEventId !== null) {
      invalidatedEventIds.add(previousEventId);
    }
    if (fixture.event !== null) invalidatedEventIds.add(fixture.event);
  }

  return { invalidatedEventIds, shouldClearUnscheduled };
}
