import { EventExplainFixtureSchema, type RawFPLEventLiveElement } from '../clients/fpl';
import type { FplPlayerFixtureEvidence } from '../domain/fpl-player-fixture-stats';

const IDENTIFIERS = {
  minutes: 'minutes',
  starts: 'starts',
  goals: 'goals_scored',
  assists: 'assists',
  ownGoals: 'own_goals',
  yellowCards: 'yellow_cards',
  redCards: 'red_cards',
} as const;

function selectedStatValue(stats: Map<string, number>, identifier: string): number {
  const value = stats.get(identifier) ?? 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid FPL fixture stat ${identifier}: ${value}`);
  }
  return value;
}

function optionalSelectedStatValue(stats: Map<string, number>, identifier: string): number | null {
  return stats.has(identifier) ? selectedStatValue(stats, identifier) : null;
}

export function transformFplPlayerFixtureEvidence(
  eventId: number,
  elements: readonly RawFPLEventLiveElement[],
): FplPlayerFixtureEvidence[] {
  const rows: FplPlayerFixtureEvidence[] = [];
  const identities = new Set<string>();
  for (const element of elements) {
    if (!Array.isArray(element.explain)) continue;
    for (const candidate of element.explain) {
      const fixture = EventExplainFixtureSchema.parse(candidate);
      const identity = `${fixture.fixture}:${element.id}`;
      if (identities.has(identity)) {
        throw new Error(
          `Duplicate FPL fixture explain: event=${eventId} fixture=${fixture.fixture} element=${element.id}`,
        );
      }
      identities.add(identity);
      const stats = new Map<string, number>();
      for (const stat of fixture.stats) {
        stats.set(stat.identifier, (stats.get(stat.identifier) ?? 0) + stat.value);
      }
      rows.push({
        eventId,
        fixtureId: fixture.fixture,
        elementId: element.id,
        minutes: selectedStatValue(stats, IDENTIFIERS.minutes),
        starts: optionalSelectedStatValue(stats, IDENTIFIERS.starts),
        goals: selectedStatValue(stats, IDENTIFIERS.goals),
        assists: selectedStatValue(stats, IDENTIFIERS.assists),
        ownGoals: selectedStatValue(stats, IDENTIFIERS.ownGoals),
        yellowCards: selectedStatValue(stats, IDENTIFIERS.yellowCards),
        redCards: selectedStatValue(stats, IDENTIFIERS.redCards),
      });
    }
  }
  return rows.sort(
    (left, right) => left.fixtureId - right.fixtureId || left.elementId - right.elementId,
  );
}
