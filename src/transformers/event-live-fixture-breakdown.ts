import { EventExplainFixtureSchema } from '../clients/fpl';
import type {
  EventLive,
  EventLiveFixtureBreakdown,
  EventLiveFixtureBreakdownStat,
} from '../domain/event-lives';
import type { RawFPLEventLiveElement } from '../types';

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeFixtureBreakdown(
  eventId: number,
  element: RawFPLEventLiveElement,
): EventLiveFixtureBreakdown[] {
  if (!Array.isArray(element.explain)) return [];

  const fixtureIds = new Set<number>();
  return element.explain
    .map((candidate) => {
      const fixture = EventExplainFixtureSchema.parse(candidate);
      if (fixtureIds.has(fixture.fixture)) {
        throw new Error(
          `Duplicate live fixture breakdown: event=${eventId} fixture=${fixture.fixture} element=${element.id}`,
        );
      }
      fixtureIds.add(fixture.fixture);

      const identifiers = new Set<string>();
      const stats: EventLiveFixtureBreakdownStat[] = fixture.stats.map((stat) => {
        const identifier = stat.identifier.trim();
        if (!identifier) {
          throw new Error(
            `Empty live fixture stat: event=${eventId} fixture=${fixture.fixture} element=${element.id}`,
          );
        }
        if (identifiers.has(identifier)) {
          throw new Error(
            `Duplicate live fixture stat: event=${eventId} fixture=${fixture.fixture} element=${element.id} identifier=${identifier}`,
          );
        }
        identifiers.add(identifier);
        return {
          identifier,
          value: stat.value,
          points: stat.points,
          pointsModification: stat.points_modification ?? null,
        };
      });

      stats.sort((left, right) => compareStrings(left.identifier, right.identifier));
      return { fixtureId: fixture.fixture, stats };
    })
    .sort((left, right) => left.fixtureId - right.fixtureId);
}

export function attachEventLiveFixtureBreakdowns(
  eventId: number,
  eventLives: readonly EventLive[],
  elements: readonly RawFPLEventLiveElement[],
): EventLive[] {
  const elementsById = new Map(elements.map((element) => [element.id, element]));
  return eventLives.map((eventLive) => {
    const element = elementsById.get(eventLive.elementId);
    if (!element) {
      throw new Error(
        `Missing live element for fixture breakdown: event=${eventId} element=${eventLive.elementId}`,
      );
    }
    return {
      ...eventLive,
      fixtureBreakdown: normalizeFixtureBreakdown(eventId, element),
    };
  });
}
