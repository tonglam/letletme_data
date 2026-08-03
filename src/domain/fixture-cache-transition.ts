export interface FixtureEventIdentity {
  id: number;
  event: number | null;
}

export interface FixtureCacheTransitions {
  staleEventIds: Set<number>;
  shouldClearUnscheduled: boolean;
}

/**
 * Compare the just-accepted FPL fixture identities with their persisted event
 * ownership before upsert. Any prior event loses its entire coordinated live
 * snapshot when a fixture moves away; a fixture leaving the unscheduled bucket
 * invalidates that separate cache as well.
 */
export function resolveFixtureCacheTransitions(
  fixtures: readonly FixtureEventIdentity[],
  previousEventByFixtureId: ReadonlyMap<number, number | null>,
): FixtureCacheTransitions {
  const staleEventIds = new Set<number>();
  let shouldClearUnscheduled = false;

  for (const fixture of fixtures) {
    const previousEventId = previousEventByFixtureId.get(fixture.id);
    if (previousEventId === undefined || previousEventId === fixture.event) continue;
    if (previousEventId === null) {
      if (fixture.event !== null) shouldClearUnscheduled = true;
    } else {
      staleEventIds.add(previousEventId);
    }
  }

  return { staleEventIds, shouldClearUnscheduled };
}
