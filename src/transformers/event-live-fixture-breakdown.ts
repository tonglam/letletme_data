import { EventExplainFixtureSchema } from '../clients/fpl';
import type {
  EventLive,
  EventLiveFixtureBreakdown,
  EventLiveFixtureBreakdownStat,
} from '../domain/event-lives';
import type { RawFPLEventLiveElement } from '../types';

const SUPPORTED_IDENTIFIERS = new Set([
  'minutes',
  'goals_scored',
  'assists',
  'clean_sheets',
  'goals_conceded',
  'own_goals',
  'penalties_saved',
  'penalties_missed',
  'yellow_cards',
  'red_cards',
  'saves',
  'bonus',
  'defensive_contribution',
]);

function normalizeFixtureBreakdown(
  eventId: number,
  element: RawFPLEventLiveElement,
): EventLiveFixtureBreakdown[] {
  if (!Array.isArray(element.explain)) return [];

  const fixtureIds = new Set<number>();
  return element.explain.map((candidate) => {
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
      if (!SUPPORTED_IDENTIFIERS.has(identifier)) {
        throw new Error(
          `Unsupported live fixture stat: event=${eventId} fixture=${fixture.fixture} element=${element.id} identifier=${identifier}`,
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

    return { fixtureId: fixture.fixture, stats };
  });
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
